/** Bounded admission for paid editor chat turns.
 *
 * The editor token authenticates a client; it does not make an accidentally
 * duplicated or runaway client cheap.  This gate therefore bounds the prompt
 * before provider construction, limits both per-session and aggregate
 * concurrency, and consumes a monotonic token-bucket reservation per accepted
 * turn.  A lease must be released in `finally`; rate tokens are intentionally
 * not refunded because the provider may already have accepted the request.
 */

export interface ChatAdmissionLimits {
  maxTextBytes: number;
  maxInFlightPerSession: number;
  maxGlobalInFlight: number;
  burst: number;
  refillIntervalMs: number;
  maxTrackedSessions: number;
  idleSessionTtlMs: number;
}

export const DEFAULT_CHAT_ADMISSION_LIMITS: Readonly<ChatAdmissionLimits> = Object.freeze({
  maxTextBytes: 32 * 1024,
  maxInFlightPerSession: 2,
  maxGlobalInFlight: 8,
  burst: 4,
  refillIntervalMs: 15_000,
  maxTrackedSessions: 256,
  idleSessionTtlMs: 30 * 60_000,
});

export type ChatAdmissionRejectionCode =
  | "text_too_large"
  | "session_busy"
  | "server_busy"
  | "rate_limited"
  | "session_capacity";

export interface ChatAdmissionRejection {
  ok: false;
  code: ChatAdmissionRejectionCode;
  message: string;
  retryAfterMs?: number;
}

export interface ChatAdmissionLease {
  ok: true;
  release(): void;
}

interface SessionState {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
  inFlight: number;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}

function validateLimits(limits: ChatAdmissionLimits): void {
  positiveSafeInteger(limits.maxTextBytes, "maxTextBytes");
  positiveSafeInteger(limits.maxInFlightPerSession, "maxInFlightPerSession");
  positiveSafeInteger(limits.maxGlobalInFlight, "maxGlobalInFlight");
  positiveSafeInteger(limits.burst, "burst");
  positiveSafeInteger(limits.refillIntervalMs, "refillIntervalMs");
  positiveSafeInteger(limits.maxTrackedSessions, "maxTrackedSessions");
  positiveSafeInteger(limits.idleSessionTtlMs, "idleSessionTtlMs");
}

export class ChatAdmissionGate {
  private readonly sessions = new Map<string, SessionState>();
  private globalInFlight = 0;

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly limits: Readonly<ChatAdmissionLimits> = DEFAULT_CHAT_ADMISSION_LIMITS,
  ) {
    validateLimits(limits);
  }

  private now(): number {
    const value = this.nowMs();
    if (!Number.isFinite(value) || value < 0) throw new Error("chat admission clock must be finite and non-negative");
    return value;
  }

  private refill(state: SessionState, now: number): void {
    // A regressing wall clock grants no tokens and cannot extend arithmetic into
    // the future. Date.now is metadata/admission time, never simulation state.
    const elapsed = Math.max(0, now - state.lastRefillMs);
    const grants = Math.floor(elapsed / this.limits.refillIntervalMs);
    if (grants > 0) {
      state.tokens = Math.min(this.limits.burst, state.tokens + grants);
      state.lastRefillMs += grants * this.limits.refillIntervalMs;
    }
    state.lastSeenMs = Math.max(state.lastSeenMs, now);
  }

  private evictIdle(now: number): void {
    for (const [sessionId, state] of this.sessions) {
      if (state.inFlight === 0 && now - state.lastSeenMs >= this.limits.idleSessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }
  }

  acquire(sessionId: string, text: string): ChatAdmissionLease | ChatAdmissionRejection {
    const textBytes = new TextEncoder().encode(text).byteLength;
    if (textBytes > this.limits.maxTextBytes) {
      return { ok: false, code: "text_too_large", message: `chat text exceeds ${this.limits.maxTextBytes} UTF-8 bytes` };
    }

    const now = this.now();
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      if (this.sessions.size >= this.limits.maxTrackedSessions) this.evictIdle(now);
      if (this.sessions.size >= this.limits.maxTrackedSessions) {
        return { ok: false, code: "session_capacity", message: "chat session capacity is full" };
      }
      state = { tokens: this.limits.burst, lastRefillMs: now, lastSeenMs: now, inFlight: 0 };
      this.sessions.set(sessionId, state);
    } else {
      this.refill(state, now);
    }

    if (state.inFlight >= this.limits.maxInFlightPerSession) {
      return { ok: false, code: "session_busy", message: "this chat session already has the maximum number of turns in flight" };
    }
    if (this.globalInFlight >= this.limits.maxGlobalInFlight) {
      return { ok: false, code: "server_busy", message: "the editor chat provider is at its global concurrency limit" };
    }
    if (state.tokens < 1) {
      const elapsed = Math.max(0, now - state.lastRefillMs);
      return {
        ok: false,
        code: "rate_limited",
        message: "chat turn rate limit exceeded",
        retryAfterMs: Math.max(1, this.limits.refillIntervalMs - elapsed),
      };
    }

    state.tokens -= 1;
    state.inFlight += 1;
    state.lastSeenMs = now;
    this.globalInFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        state!.inFlight -= 1;
        this.globalInFlight -= 1;
        state!.lastSeenMs = this.now();
      },
    };
  }

  snapshot(): Readonly<{ sessions: number; globalInFlight: number }> {
    return Object.freeze({ sessions: this.sessions.size, globalInFlight: this.globalInFlight });
  }
}
