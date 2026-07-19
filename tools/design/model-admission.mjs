const encoder = new TextEncoder();

export class DesignModelAdmission {
  #tokens;
  #lastRefillMs;
  #inFlight = 0;

  constructor({
    nowMs = () => Date.now(),
    maxInFlight = 2,
    burst = 8,
    refillIntervalMs = 7_500,
    maxMessageBytes = 32 * 1024,
    maxHistoryBytes = 256 * 1024,
  } = {}) {
    for (const [name, value] of Object.entries({ maxInFlight, burst, refillIntervalMs, maxMessageBytes, maxHistoryBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }
    this.nowMs = nowMs;
    this.maxInFlight = maxInFlight;
    this.burst = burst;
    this.refillIntervalMs = refillIntervalMs;
    this.maxMessageBytes = maxMessageBytes;
    this.maxHistoryBytes = maxHistoryBytes;
    this.#tokens = burst;
    this.#lastRefillMs = this.#now();
  }

  #now() {
    const value = this.nowMs();
    if (!Number.isFinite(value) || value < 0) throw new Error("model admission clock must be finite and non-negative");
    return value;
  }

  acquire(message, history) {
    if (encoder.encode(String(message ?? "")).byteLength > this.maxMessageBytes) {
      return { ok: false, status: 413, code: "message_too_large", message: `agent message exceeds ${this.maxMessageBytes} UTF-8 bytes` };
    }
    let historyText;
    try { historyText = JSON.stringify(history ?? []); }
    catch { return { ok: false, status: 400, code: "invalid_history", message: "agent history must be JSON-serializable" }; }
    if (encoder.encode(historyText).byteLength > this.maxHistoryBytes) {
      return { ok: false, status: 413, code: "history_too_large", message: `agent history exceeds ${this.maxHistoryBytes} UTF-8 bytes` };
    }
    const now = this.#now();
    const grants = Math.floor(Math.max(0, now - this.#lastRefillMs) / this.refillIntervalMs);
    if (grants > 0) {
      this.#tokens = Math.min(this.burst, this.#tokens + grants);
      this.#lastRefillMs += grants * this.refillIntervalMs;
    }
    if (this.#inFlight >= this.maxInFlight) {
      return { ok: false, status: 429, code: "provider_busy", message: "design model concurrency limit reached" };
    }
    if (this.#tokens < 1) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "design model rate limit reached",
        retryAfterMs: Math.max(1, this.refillIntervalMs - Math.max(0, now - this.#lastRefillMs)),
      };
    }
    this.#tokens -= 1;
    this.#inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
      },
    };
  }

  snapshot() { return Object.freeze({ inFlight: this.#inFlight, tokens: this.#tokens }); }
}
