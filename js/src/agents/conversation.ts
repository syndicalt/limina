// Turn-based, live Ollama dialogue orchestrator (Wave 2). Drives the windowed
// forest demo: an agent-controlled player walks up to a forest NPC and they hold
// a SHORT, real-time, NON-DETERMINISTIC conversation rendered as speech bubbles.
//
// FRAME-DRIVEN by design (this is load-bearing for the windowed host):
//   The windowed host advances the JS event loop to QUIESCENCE once per frame
//   (poll_event_loop().await). A long-lived async/await chain (e.g. an
//   `await op_sleep_ms` polling loop) never lets the loop quiesce, which starves
//   the fixed-step + render callbacks — the player would freeze mid-walk. So the
//   director is a SYNCHRONOUS per-frame state machine: tick() is called from the
//   host's fixed-step callback, advances one step, and returns immediately.
//   Waits (walk arrival, line holds, beats) are counted in FRAMES, not awaited.
//
// Turn arbiter: tick() owns the floor explicitly. Exactly one speaker speaks per
//   turn, strictly alternating; nothing is ever dropped (unlike the autonomous
//   decisionSystem, whose re-admission can drop a one-shot tool call). The player
//   opens; the bounded exchange runs ~linesPerExchange lines; then the player
//   walks to the next NPC.
//
// The ONE genuinely-async piece is the LLM round-trip (op_http_post). It is fired
//   DETACHED (not awaited in the frame path) and its result is picked up by a
//   later tick via a `pending` flag. While that single op is in flight the host
//   necessarily pauses (it has no other JS work) — that pause IS the model
//   "thinking", and the HUD shows it honestly. Everything else (walking, holds)
//   renders smoothly because no async is pending.
//
// Real traced events around every LLM call (so the HUD honestly shows
//   "thinking -> replied"):
//     agent.thinking { model, partner, turn }              <- when the call fires
//     llm.response   { model, latencyMs, evalCount, ... }  <- when it resolves
//   then the spoken line goes through the REAL social.say skill (host-bound
//   attribution -> social.said + skill.executed + a live speech bubble). No
//   canned content: every line is whatever the model generated this run.
//
// Honest when Ollama is unreachable: a rejected chat sets pending.ok=false; the
//   director emits llm.unavailable, reports the status, and STOPS gracefully — it
//   NEVER fabricates a line or a fallback bubble.

import { ops } from "../engine.ts";
import type { LiminaTracer } from "../observability/event.ts";
import { resolveProfile } from "../skills/permissions.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { Locomotion } from "../world/locomotion.ts";
import type { ChatClient, ChatMessage } from "./llm.ts";

/** A conversational character: the agent id its embodiment + social.* bind to,
 *  a display name, and a system-prompt "voice" giving it a distinct character. */
export interface Persona {
  /** agt_ id (bound to a humanoid via Locomotion; the host-bound speaker). */
  agentId: string;
  /** Display name used in prompts, the HUD, and the on-screen status. */
  name: string;
  /** System-prompt voice: who they are + how they speak (kept brief, in char). */
  voice: string;
}

export interface ConversationOptions {
  registry: SkillRegistry;
  world: WorldContext;
  tracer: LiminaTracer;
  locomotion: Locomotion;
  chat: ChatClient;
  /** Model id (for trace payloads + status lines). */
  model: string;
  sessionId: string;
  /** The agent-controlled walker who opens each exchange. */
  player: Persona;
  /** The POOL of NPCs the player can approach (UNORDERED). Before each approach
   *  the player LLM-chooses one from those NOT yet visited (the `choosing`
   *  phase); the visiting order is decided live, not by this array's order. */
  npcs: Persona[];
  /** Total spoken lines per exchange (player + NPC alternating); default 4. */
  linesPerExchange?: number;
  /** Frames a spoken line lingers before the partner replies; default 110 (~1.8s @60). */
  holdFrames?: number;
  /** Frames to pause after an exchange before walking on; default 80 (~1.3s @60). */
  beatFrames?: number;
  /** Frames to allow for a walk-up before giving up; default 1800 (~30s @60). */
  arrivalFrames?: number;
  /** Frames to SETTLE the camera into the side two-shot after arrival, BEFORE the
   *  first LLM line fires (deterministic; no say during it); default 48 (~0.8s @60). */
  framingFrames?: number;
  /** Polled status sink (the demo renders it on-screen + logs it). */
  onStatus?: (status: string) => void;
  /** Clear (fade out + remove) the given agents' speech bubbles. Called when an
   *  exchange ends (the finished pair) and at conversation end (everyone). */
  clearBubbles?: (agentIds: string[]) => void;
  /** Query whether the given speaker's live speech bubble has FULLY revealed its
   *  current line (typewriter complete). The `holding` phase gates on this so a
   *  long line finishes typing before the reply. Omitted -> the hold is not
   *  reveal-gated (advances on `holdFrames` alone). */
  bubbleRevealed?: (agentId: string) => boolean;
  /** Called when a line is spoken (speaker agentId + text) so a host can voice it
   *  (TTS). Fire-and-forget; never blocks the turn arbiter. */
  onSpeak?: (agentId: string, text: string) => void;
}

export type ConversationOutcome =
  | { ok: true; exchanges: number; lines: number }
  | {
      ok: false;
      reason: "llm_unreachable" | "no_arrival" | "empty_line" | "say_failed";
      detail: string;
      exchanges: number;
      lines: number;
    };

const MAX_LINE = 170; // keep a spoken line to a few wide bubble rows; social.say caps at 280.
const DEFAULT_FRAMING_FRAMES = 48; // ~0.8s @60: the camera glides into the two-shot, settled, before the first say.

/** Clean an LLM reply into a single spoken line: trim, collapse whitespace, drop
 *  a wrapping quote pair and a leading "Name:" prefix, and clamp length at a
 *  sentence/word boundary. Pure + exported so it can be unit-tested. */
export function sanitizeLine(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  s = s.replace(/^["'\u201C\u2018]+/, "").replace(/["'\u201D\u2019]+$/, "").trim();
  s = s.replace(/^[A-Z][a-zA-Z]{0,20}:\s+/, ""); // a stray "Birch: ..." speaker prefix
  if (s.length > MAX_LINE) {
    const cut = s.slice(0, MAX_LINE);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (stop > 80) {
      s = cut.slice(0, stop + 1).trim();
    } else {
      const space = cut.lastIndexOf(" ");
      s = (space > 0 ? cut.slice(0, space) : cut).trim() + "\u2026";
    }
  }
  return s;
}

type Phase = "init" | "choosing" | "approaching" | "framing" | "thinking" | "holding" | "beat" | "done";

interface TranscriptEntry {
  speaker: Persona;
  text: string;
}

interface PendingReply {
  done: boolean;
  ok: boolean;
  text?: string;
  latencyMs?: number;
  evalCount?: number;
  error?: string;
}

export class ConversationDirector {
  private frame = 0;
  private phase: Phase = "init";
  /** Unvisited NPCs the player can still approach (the POOL). The player LLM-picks
   *  `current` from this each `choosing` phase; the picked one is removed.
   *  Initialized from opts.npcs at init (treated as UNORDERED). */
  private remaining: Persona[] = [];
  /** The NPC chosen for the active approach/exchange (set when `choosing`
   *  resolves; undefined while choosing or done). */
  private current: Persona | undefined;
  private turn = 0;
  private exchanges = 0;
  private lines = 0;
  private waitUntil = 0;
  private deadlineFrame = 0;
  private transcript: TranscriptEntry[] = [];
  private pending: PendingReply | undefined;
  /** The detached partner-choice round-trip in flight (frame-driven pickup, like
   *  `pending` for dialogue); undefined when no choice is being decided. */
  private pendingChoice: PendingReply | undefined;
  /** In `holding`: false until the spoken line has FULLY revealed; then the
   *  readable `holdFrames` countdown is armed. Reset on each new line. */
  private holdArmed = false;
  private lastThinkId: string | undefined;
  private result: ConversationOutcome | undefined;

  constructor(private readonly opts: ConversationOptions) {}

  /** The final outcome once the conversation has ended (otherwise undefined). */
  get outcome(): ConversationOutcome | undefined {
    return this.result;
  }

  /** True once the conversation has fully ended (success or honest failure). */
  get finished(): boolean {
    return this.phase === "done";
  }

  /** True while an exchange is live: the camera frames the speaking pair in a
   *  side two-shot through FRAMING and the talk (framing -> thinking/holding/beat).
   *  Framing is the deterministic settle window BEFORE the first line fires. */
  get inConversation(): boolean {
    return this.phase === "framing" || this.phase === "thinking" || this.phase === "holding" || this.phase === "beat";
  }

  /** True only during the deterministic camera-settle window after arrival and
   *  BEFORE the first LLM line: the camera glides into the two-shot with nothing
   *  pending; once it elapses `talking` fires the first say. */
  get framing(): boolean {
    return this.phase === "framing";
  }

  /** True while the player is LLM-deciding whom to approach next (before the
   *  walk-up). Not part of `inConversation`: the camera follows the player. */
  get choosing(): boolean {
    return this.phase === "choosing";
  }

  /** True while a spoken line lingers: tickHolding waits for the bubble to fully
   *  reveal, then counts holdFrames, before the next turn. */
  get holding(): boolean {
    return this.phase === "holding";
  }

  /** The agent the player is currently talking with (undefined while walking or
   *  done) — lets the camera frame the right pair. */
  get activePartnerAgentId(): string | undefined {
    return this.inConversation ? this.currentNpc().agentId : undefined;
  }

  /** Advance the conversation ONE frame. Call from the host fixed-step callback,
   *  AFTER locomotion.step (so arrival is current). Synchronous + cheap. */
  tick(): void {
    this.frame++;
    switch (this.phase) {
      case "init":
        this.status(`LLM connecting\u2026 (${this.opts.model})`);
        this.emit("conversation.started", this.opts.player.agentId, { model: this.opts.model, npcs: this.opts.npcs.map((n) => n.name) });
        this.remaining = [...this.opts.npcs]; // opts.npcs is an UNORDERED pool; the player LLM-picks the order.
        this.beginChoosing();
        return;
      case "approaching":
        if (this.opts.locomotion.hasArrived(this.opts.player.agentId)) {
          this.beginExchange();
        } else if (this.frame > this.deadlineFrame) {
          this.finishFail("no_arrival", `did not reach ${this.currentNpc().name} within budget`);
        }
        return;
      case "choosing":
        this.tickChoosing();
        return;
      case "framing":
        if (this.frame >= this.waitUntil) this.beginTalking();
        return;
      case "thinking":
        this.tickThinking();
        return;
      case "holding":
        this.tickHolding();
        return;
      case "beat":
        if (this.frame >= this.waitUntil) this.finishExchange();
        return;
      case "done":
        return;
    }
  }

  // -- phase bodies -----------------------------------------------------------

  private tickThinking(): void {
    if (this.pending === undefined) {
      this.fireThink();
      return;
    }
    if (!this.pending.done) return; // model still working (host paused on the op)

    const reply = this.pending;
    this.pending = undefined;
    if (!reply.ok) {
      const detail = reply.error ?? "unknown error";
      this.status(`LLM offline / waiting \u2014 ${detail} (no dialogue fabricated)`);
      this.emit("llm.unavailable", this.speaker().agentId, { model: this.opts.model, error: detail, turn: this.turn }, this.cause());
      this.finishFail("llm_unreachable", detail);
      return;
    }
    this.emit("llm.response", this.speaker().agentId, {
      model: this.opts.model,
      latencyMs: reply.latencyMs,
      evalCount: reply.evalCount,
      chars: reply.text?.length ?? 0,
      turn: this.turn,
    }, this.cause());

    const text = reply.text ?? "";
    if (text.length === 0) {
      this.status(`${this.speaker().name} fell silent (empty LLM reply)`);
      this.emit("conversation.silent", this.speaker().agentId, { turn: this.turn });
      this.finishFail("empty_line", "model returned an empty line");
      return;
    }
    this.speak(text);
  }

  /** Fire the (single) detached LLM round-trip for the current speaker. NOT
   *  awaited: the result is collected by a later tick via `this.pending`. */
  private fireThink(): void {
    const speaker = this.speaker();
    const partner = this.partner();
    this.status(`${speaker.name} is thinking\u2026`);
    this.lastThinkId = this.emit("agent.thinking", speaker.agentId, { model: this.opts.model, partner: partner.name, turn: this.turn });

    const messages = this.buildMessages(speaker, partner);
    const pending: PendingReply = { done: false, ok: false };
    this.pending = pending;
    // No op_sleep_ms timeout here: a losing race timer would stay pending and
    // pause the windowed host. A dead server REJECTS fast (connection refused),
    // which is handled honestly below.
    this.opts.chat.chat(messages)
      .then((r) => {
        pending.done = true;
        pending.ok = true;
        pending.text = sanitizeLine(r.content);
        pending.latencyMs = r.latencyMs;
        pending.evalCount = r.evalCount;
      })
      .catch((err: unknown) => {
        pending.done = true;
        pending.ok = false;
        pending.error = err instanceof Error ? err.message : String(err);
      });
  }

  /** Speak `text` as the current speaker (real social.say -> bubble + traced),
   *  then hold for `holdFrames` before the next turn. */
  private speak(text: string): void {
    const speaker = this.speaker();
    // Fire-and-forget: social.say's handler runs + authors the bubble in the
    // resolving microtask (no I/O), so it never pauses the host.
    void this.opts.registry.invoke("social.say", { text }, this.ctx(speaker.agentId)).then((res) => {
      if (!res.success) ops.op_log(`[convo] social.say failed: ${res.error?.message ?? "unknown"}`);
    });
    this.transcript.push({ speaker, text });
    this.opts.onSpeak?.(speaker.agentId, text);
    this.lines++;
    ops.op_log(`[SAID] ${speaker.name}: ${text}`); // grep-able transcript evidence
    this.status(`${speaker.name}: ${text}`);
    // Reveal-gated hold: enter `holding` UN-armed. tickHolding waits for the
    // bubble to FULLY type this line, THEN counts holdFrames before advancing —
    // so a long line is never cut off by the reply.
    this.holdArmed = false;
    this.phase = "holding";
  }

  /** `holding` body: do NOT advance until the current speaker's bubble has FULLY
   *  revealed its line; THEN count `holdFrames` (a readable pause); THEN advance.
   *  So every statement fully appears + is readable before the reply. */
  private tickHolding(): void {
    if (!this.holdArmed) {
      if (!this.currentLineRevealed()) return; // typewriter still revealing — wait.
      this.holdArmed = true;
      this.waitUntil = this.frame + (this.opts.holdFrames ?? 110);
      return;
    }
    if (this.frame >= this.waitUntil) this.advanceTurn();
  }

  /** Whether the current speaker's bubble has finished typing its line. With no
   *  `bubbleRevealed` probe wired the hold is not reveal-gated (returns true). */
  private currentLineRevealed(): boolean {
    const probe = this.opts.bubbleRevealed;
    return probe === undefined ? true : probe(this.speaker().agentId);
  }

  private advanceTurn(): void {
    this.turn++;
    if (this.turn < (this.opts.linesPerExchange ?? 4)) {
      this.phase = "thinking"; // next speaker takes the floor
    } else {
      this.exchanges++;
      this.waitUntil = this.frame + (this.opts.beatFrames ?? 80);
      this.phase = "beat";
    }
  }

  private finishExchange(): void {
    // The exchange with this partner is over — clear that pair's bubbles before
    // moving on, so lingering lines never trail the camera to the next speaker.
    const finished = this.currentNpc();
    this.opts.clearBubbles?.([this.opts.player.agentId, finished.agentId]);
    // Choose again from whoever is LEFT; beginChoosing ends the conversation once
    // the pool is empty.
    this.beginChoosing();
  }

  /** Enter the `choosing` phase: the player will LLM-pick the next NPC from the
   *  unvisited pool. Ends the conversation when the pool is empty. */
  private beginChoosing(): void {
    if (this.remaining.length === 0) {
      this.finishConversation();
      return;
    }
    this.current = undefined;
    this.pendingChoice = undefined;
    this.status(`${this.opts.player.name} considers who to approach\u2026`);
    this.phase = "choosing";
  }

  /** `choosing` body: fire the (single) detached partner-choice round-trip, then
   *  on a later tick map the reply to a pool NPC and approach them. DETACHED +
   *  frame-driven (like the dialogue): no await in the per-frame path. */
  private tickChoosing(): void {
    if (this.pendingChoice === undefined) {
      this.fireChoose();
      return;
    }
    if (!this.pendingChoice.done) return; // player still deciding (host paused on the op)

    const reply = this.pendingChoice;
    this.pendingChoice = undefined;
    if (!reply.ok) {
      const detail = reply.error ?? "unknown error";
      this.status(`LLM offline / waiting \u2014 ${detail} (no choice fabricated)`);
      this.emit("llm.unavailable", this.opts.player.agentId, { model: this.opts.model, error: detail, phase: "choosing" }, this.cause());
      this.finishFail("llm_unreachable", detail);
      return;
    }
    const { who, matched } = this.chooseFrom(this.remaining, reply.text ?? "");
    this.remaining = this.remaining.filter((p) => p !== who);
    this.current = who;
    this.emit("conversation.choose", this.opts.player.agentId, {
      who: who.agentId,
      name: who.name,
      matched,
      reply: reply.text ?? "",
      remaining: this.remaining.map((p) => p.name),
    }, this.cause());
    this.status(`${this.opts.player.name} decides to approach ${who.name}${matched ? "" : " (fallback)"}\u2026`);
    this.beginApproach();
  }

  /** Fire the (single) detached partner-choice chat for the player. NOT awaited:
   *  collected by a later tick via `this.pendingChoice` (same shape as a dialogue
   *  reply). A rejected chat is an honest failure (no fabricated choice). */
  private fireChoose(): void {
    const player = this.opts.player;
    this.status(`${player.name} is choosing who to approach\u2026`);
    this.lastThinkId = this.emit("agent.thinking", player.agentId, {
      model: this.opts.model,
      phase: "choosing",
      remaining: this.remaining.map((p) => p.name),
    });
    const messages = this.buildChooseMessages(this.remaining);
    const pending: PendingReply = { done: false, ok: false };
    this.pendingChoice = pending;
    this.opts.chat.chat(messages)
      .then((r) => {
        pending.done = true;
        pending.ok = true;
        pending.text = r.content;
        pending.latencyMs = r.latencyMs;
        pending.evalCount = r.evalCount;
      })
      .catch((err: unknown) => {
        pending.done = true;
        pending.ok = false;
        pending.error = err instanceof Error ? err.message : String(err);
      });
  }

  /** Map the model's free-form reply to ONE pool NPC by case-insensitive name/id
   *  substring (the FIRST pool entry the reply mentions wins). On a miss fall back
   *  to the first remaining NPC — a deterministic but REAL selection — and report
   *  it (`matched=false`). */
  private chooseFrom(pool: Persona[], reply: string): { who: Persona; matched: boolean } {
    const hay = reply.toLowerCase();
    for (const p of pool) {
      const id = p.agentId.toLowerCase();
      const idShort = id.replace(/^agt_/, "");
      if (hay.includes(p.name.toLowerCase()) || hay.includes(idShort) || hay.includes(id)) {
        return { who: p, matched: true };
      }
    }
    return { who: pool[0], matched: false };
  }

  /** End the conversation successfully: report, clear every bubble, record the
   *  outcome. Reached when the pool of NPCs is exhausted. */
  private finishConversation(): void {
    this.status(`Conversation complete \u2014 ${this.exchanges} exchanges, ${this.lines} lines (live ${this.opts.model})`);
    this.emit("conversation.ended", this.opts.player.agentId, { exchanges: this.exchanges, lines: this.lines, model: this.opts.model });
    // Clear every speaker's bubble at the end — the air goes quiet.
    this.opts.clearBubbles?.([this.opts.player.agentId, ...this.opts.npcs.map((n) => n.agentId)]);
    this.result = { ok: true, exchanges: this.exchanges, lines: this.lines };
    ops.op_log(`[convo] outcome: ${JSON.stringify(this.result)}`);
    this.phase = "done";
  }

  private beginApproach(): void {
    const npc = this.currentNpc();
    this.status(`${this.opts.player.name} walks toward ${npc.name}\u2026`);
    this.emit("conversation.approach", this.opts.player.agentId, { target: npc.agentId, name: npc.name });
    // REAL social.approach (host-bound) -> the locomotion target the frame loop
    // pursues. Resolves in a microtask (no host pause).
    void this.opts.registry.invoke("social.approach", { target: npc.agentId }, this.ctx(this.opts.player.agentId)).then((res) => {
      if (!res.success) {
        this.status(`approach failed: ${res.error?.message ?? "unknown"}`);
        this.finishFail("no_arrival", `social.approach failed: ${res.error?.message ?? "unknown"}`);
      }
    });
    this.deadlineFrame = this.frame + (this.opts.arrivalFrames ?? 1800);
    this.phase = "approaching";
  }

  private beginExchange(): void {
    // Arrived: enter FRAMING first — a deterministic K-frame settle window during
    // which the camera glides into the side two-shot with NOTHING pending. The
    // first LLM line fires only once framing completes (beginTalking), so the
    // camera is already in place when the brief inference pause then happens.
    this.turn = 0;
    this.transcript = [];
    this.status(`${this.opts.player.name} reaches ${this.currentNpc().name}\u2026`);
    this.waitUntil = this.frame + (this.opts.framingFrames ?? DEFAULT_FRAMING_FRAMES);
    this.phase = "framing";
  }

  /** Framing settle window elapsed: take the floor and fire the first line. */
  private beginTalking(): void {
    this.status(`${this.opts.player.name} and ${this.currentNpc().name} are talking\u2026`);
    this.phase = "thinking";
  }

  private finishFail(reason: Exclude<ConversationOutcome, { ok: true }>["reason"], detail: string): void {
    this.result = { ok: false, reason, detail, exchanges: this.exchanges, lines: this.lines };
    ops.op_log(`[convo] outcome: ${JSON.stringify(this.result)}`);
    this.phase = "done";
  }

  // -- prompt construction ----------------------------------------------------

  /** Build the chat messages for the partner CHOICE: the player's persona + the
   *  available NPCs (name + one-line voice), asking who to approach. Kept short;
   *  the reply is mapped to a pool NPC by chooseFrom. */
  private buildChooseMessages(pool: Persona[]): ChatMessage[] {
    const roster = pool.map((p) => `- ${p.name}: ${p.voice}`).join("\n");
    const names = pool.map((p) => p.name).join(", ");
    const system =
      `${this.opts.player.voice}\n` +
      `You are ${this.opts.player.name}, wandering a quiet, sunlit forest grove. A few figures stand apart ` +
      `from one another nearby, and you can only walk up to ONE of them first.`;
    const user =
      `The figures nearby are:\n${roster}\n\n` +
      `Who do you walk up to first? Answer with ONLY their name (one of: ${names}) \u2014 nothing else.`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  /** Build the chat messages for the current speaker's turn: their persona/system
   *  prompt + the running transcript from THEIR point of view (own lines as
   *  assistant, the partner's as user). Always ends on a user turn so the model
   *  has something to answer (a scene cue opens the very first line). */
  private buildMessages(speaker: Persona, partner: Persona): ChatMessage[] {
    const system =
      `${speaker.voice}\n` +
      `You are ${speaker.name}, speaking with ${partner.name} in a quiet, sunlit forest grove. ` +
      `Reply with ONLY your spoken line \u2014 ONE or two SHORT sentences (about 25 words max), in character. ` +
      `No narration, no stage directions, no quotation marks, and do not prefix your name.`;
    const msgs: ChatMessage[] = [{ role: "system", content: system }];
    for (const entry of this.transcript) {
      msgs.push({ role: entry.speaker === speaker ? "assistant" : "user", content: entry.text });
    }
    if (msgs[msgs.length - 1].role !== "user") {
      msgs.push({
        role: "user",
        content: this.transcript.length === 0
          ? `You walk up to ${partner.name} on the forest trail. Greet them and open a brief conversation.`
          : `Continue your conversation with ${partner.name}.`,
      });
    }
    return msgs;
  }

  // -- helpers ----------------------------------------------------------------

  private currentNpc(): Persona {
    if (this.current === undefined) throw new Error("conversation: no active partner (currentNpc called outside an exchange)");
    return this.current;
  }

  /** The agent who holds the floor this turn (player opens; strictly alternating). */
  private speaker(): Persona {
    return this.turn % 2 === 0 ? this.opts.player : this.currentNpc();
  }

  private partner(): Persona {
    return this.turn % 2 === 0 ? this.currentNpc() : this.opts.player;
  }

  private cause(): string[] {
    return this.lastThinkId === undefined ? [] : [this.lastThinkId];
  }

  /** Per-speaker invocation context: host-bound to the speaker's agent id with
   *  the social.actor profile (which carries social.act). */
  private ctx(agentId: string): InvokeBase {
    return {
      agentId,
      sessionId: this.opts.sessionId,
      permissions: resolveProfile("social.actor"),
      tick: this.frame,
      world: this.opts.world,
    };
  }

  private emit(type: string, actorId: string, payload: unknown, causedBy: string[] = []): string {
    return this.opts.tracer.emit({
      type,
      actorId,
      threadId: this.opts.sessionId,
      parentEventId: null,
      causedBy,
      payload,
    });
  }

  private status(s: string): void {
    this.opts.onStatus?.(s);
  }
}
