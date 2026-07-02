// LLMProvider seam — one interface, swappable backends. Providers return
// CANDIDATE tool calls; the DecisionSystem validates them against skill schemas
// before enqueuing (so a malformed/hallucinated call is never executed).

import { ops } from "../engine.ts";
import type { MCPRequest, MCPTool } from "../mcp/protocol.ts";
import type { Perception } from "./agent.ts";

export interface DecideRequest {
  systemPrompt: string;
  perception: Perception;
  tools: MCPTool[];
  previousResults: unknown[];
  /** The caller's direct instruction for this turn (e.g. the chat message). Passed
   *  explicitly rather than scraped from perception.recentEvents, which the live
   *  server's per-tick event stream can crowd out. Preferred when present. */
  userMessage?: string;
}

export interface LLMProvider {
  readonly name: string;
  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; text?: string; usage?: { totalTokens?: number } }>;
}

/** Deterministic policy function — the CI test path and the demo baseline. */
export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly policy: (req: DecideRequest) => MCPRequest[]) {}
  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[] }> {
    return Promise.resolve({ toolCalls: this.policy(req) });
  }
}

/** Local Ollama via op_http_post. Slow but free/offline; the live smoke. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  constructor(
    private readonly model: string,
    private readonly url = "http://localhost:11434/api/chat",
  ) {}

  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[] }> {
    // Function names must match ^[A-Za-z0-9_-]+$ — encode the skill's dot as "__".
    const tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name.replaceAll(".", "__"), description: t.description, parameters: t.input_schema },
    }));
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: JSON.stringify(req.perception) },
      ],
      tools,
    });
    const text = await ops.op_http_post(this.url, body);
    return { toolCalls: parseOllamaToolCalls(text) };
  }
}

/** A free-form chat turn (no tool calls) — what the live conversation demo needs.
 *  The OllamaProvider above shapes /api/chat for native tool_calls; a turn-based
 *  dialogue instead wants the assistant's spoken text back, so this is a thin,
 *  REAL op_http_post chat call (NOT a stub) that returns the message content plus
 *  the latency + token counts the HUD/trace surface. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatTurnResult {
  /** The assistant's reply text (message.content). */
  content: string;
  /** Wall-clock latency of the round-trip (ms) — the real "thinking" time. */
  latencyMs: number;
  /** Tokens the model generated this turn (Ollama eval_count), 0 if absent. */
  evalCount: number;
  /** Prompt tokens evaluated this turn (Ollama prompt_eval_count), 0 if absent. */
  promptEvalCount: number;
}

/** The minimal free-form chat seam the ConversationDirector depends on: one
 *  round-trip returning the assistant's spoken line + latency/token counts.
 *  `OllamaChat` is the live implementation; deterministic tests supply a stub. */
export interface ChatClient {
  chat(messages: ChatMessage[], opts?: { timeoutMs?: number; temperature?: number }): Promise<ChatTurnResult>;
}

/** Local Ollama /api/chat client for free-form dialogue. Non-deterministic by
 *  default (temperature 0.9). Honest failure: a dead server / non-JSON / empty
 *  reply REJECTS — callers must surface "offline", never fabricate a line. */
export class OllamaChat implements ChatClient {
  constructor(
    private readonly model: string,
    private readonly url = "http://localhost:11434/api/chat",
    private readonly temperature = 0.9,
  ) {}

  /** One chat round-trip. `timeoutMs` (optional) races the slow model against a
   *  sleep so the caller never blocks forever; a timeout REJECTS. */
  async chat(messages: ChatMessage[], opts: { timeoutMs?: number; temperature?: number } = {}): Promise<ChatTurnResult> {
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      options: { temperature: opts.temperature ?? this.temperature },
      messages,
    });
    const start = Date.now();
    const post = ops.op_http_post(this.url, body);
    const raw = opts.timeoutMs === undefined
      ? await post
      : await Promise.race([
        post,
        ops.op_sleep_ms(Math.max(0, Math.ceil(opts.timeoutMs))).then((): never => {
          throw new Error(`ollama chat timed out after ${opts.timeoutMs}ms`);
        }),
      ]);
    return { ...parseOllamaChat(raw), latencyMs: Date.now() - start };
  }
}

/** Parse Ollama /api/chat (stream:false): { message: { content }, eval_count,
 *  prompt_eval_count }. Throws on non-JSON, an {error} body, or an empty reply
 *  so an offline/garbled server is never mistaken for real dialogue. */
export function parseOllamaChat(text: string): { content: string; evalCount: number; promptEvalCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ollama chat: non-JSON response");
  }
  const root = asRecord(parsed);
  const message = asRecord(root?.message);
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (content.length === 0) {
    const err = typeof root?.error === "string" ? root.error : "empty response";
    throw new Error(`ollama chat: ${err}`);
  }
  return {
    content,
    evalCount: typeof root?.eval_count === "number" ? root.eval_count : 0,
    promptEvalCount: typeof root?.prompt_eval_count === "number" ? root.prompt_eval_count : 0,
  };
}

/** Cloud OpenAI-compatible gateway (same transport). Stubbed for MVP. */
export class GatewayProvider implements LLMProvider {
  readonly name = "gateway";
  constructor(private readonly model: string) {}
  decide(): Promise<{ toolCalls: MCPRequest[] }> {
    return Promise.reject(new Error(`GatewayProvider(${this.model}) not configured (Phase 2)`));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Ollama native /api/chat: message.tool_calls[].function.{name, arguments(object)}.
 *  Falls back to a {name, arguments} JSON object in message.content (smaller models
 *  sometimes emit the call as text). Tool names are decoded "__" -> ".". */
export function parseOllamaToolCalls(text: string): MCPRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const message = asRecord(asRecord(parsed)?.message);
  if (message === undefined) return [];
  const out: MCPRequest[] = [];
  const calls = message.tool_calls;
  if (Array.isArray(calls)) {
    for (const candidate of calls) {
      const fn = asRecord(asRecord(candidate)?.function);
      if (fn === undefined || typeof fn.name !== "string") continue;
      out.push({ tool: fn.name.replaceAll("__", "."), input: asRecord(fn.arguments) ?? {} });
    }
  }
  if (out.length === 0 && typeof message.content === "string" && message.content.length > 0) {
    const fallback = parseToolCallFromContent(message.content);
    if (fallback !== undefined) out.push(fallback);
  }
  return out;
}

function parseToolCallFromContent(content: string): MCPRequest | undefined {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return undefined;
  }
  const rec = asRecord(obj);
  if (rec === undefined || typeof rec.name !== "string") return undefined;
  return { tool: rec.name.replaceAll("__", "."), input: asRecord(rec.arguments) ?? {} };
}

// ── Anthropic Messages API provider ──────────────────────────────────────────
// A real op_http_post_headers call (x-api-key + anthropic-version). Skill names
// carry dots; Anthropic tool names must match ANTHROPIC_TOOL_NAME_RE, so encode
// "." as "__" on the wire and decode on the way back. Needs api.anthropic.com on
// the LIMINA_HTTP_POST_ALLOW allowlist + ANTHROPIC_API_KEY (both from .env).
const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function encodeAnthropicToolName(name: string): string {
  const encoded = name.replaceAll(".", "__");
  if (!ANTHROPIC_TOOL_NAME_RE.test(encoded)) {
    throw new Error(`anthropic: tool name '${name}' cannot be encoded as a valid Anthropic tool name`);
  }
  return encoded;
}

function decodeAnthropicToolName(name: string): string {
  return name.replaceAll("__", ".");
}

/** Build the user message: lead with the human's plain-language instruction, plus
 *  prior tool results for multi-step turns. The instruction comes from
 *  `req.userMessage` when present (passed explicitly); the perception `chat.user:`
 *  scrape is only a fallback for callers that don't set it. Sending raw perception
 *  JSON made the model treat it as data and merely acknowledge; a natural
 *  instruction makes it CALL skills. It can query scene state via read skills. */
function buildAnthropicUserMessage(req: DecideRequest): string {
  const direct = typeof req.userMessage === "string" ? req.userMessage.trim() : "";
  const events = Array.isArray(req.perception?.recentEvents) ? req.perception.recentEvents : [];
  const instructions: string[] = [];
  for (const ev of events) {
    const t = (ev as { type?: unknown }).type;
    if (typeof t === "string" && t.startsWith("chat.user:")) {
      instructions.push(t.slice("chat.user:".length).trim());
    }
  }
  const request = direct.length > 0
    ? direct
    : (instructions.length > 0 ? instructions.join("\n") : "Continue the previous work.");
  const prior = Array.isArray(req.previousResults) ? req.previousResults : [];
  if (prior.length === 0) {
    // FIRST step of the turn: do the request now.
    return [
      `User request:\n${request}`,
      "",
      "Carry this out now by CALLING the appropriate skill(s) — do not just describe or acknowledge it.",
    ].join("\n");
  }
  // FOLLOW-UP step: work has already been done this turn. Frame it as "are we done?"
  // — NOT a repeat of the original imperative, which is what makes the model re-run
  // a create it already succeeded at (one sphere → three spheres).
  return [
    `Original request:\n${request}`,
    "",
    `Tool calls you have ALREADY made this turn, with their results (JSON):\n${JSON.stringify(prior).slice(0, 6000)}`,
    "",
    "Check whether the original request is now fully satisfied. If it is, STOP: make NO further tool calls and reply with one short summary sentence. Do NOT repeat a call you already made, and do NOT add anything the user did not ask for. Only call another skill if the request genuinely still needs it.",
  ].join("\n");
}

function parseAnthropicMessagesResponse(
  text: string,
): { toolCalls: MCPRequest[]; text?: string; usage?: { totalTokens?: number } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("anthropic: non-JSON response");
  }
  const root = asRecord(parsed);
  if (root === undefined) throw new Error("anthropic: response must be an object");
  if (typeof root.error === "object" && root.error !== null) {
    const err = asRecord(root.error);
    const message = typeof err?.message === "string" ? err.message : "API error";
    throw new Error(`anthropic: ${message}`);
  }
  const toolCalls: MCPRequest[] = [];
  const textBlocks: string[] = [];
  const content = root.content;
  if (Array.isArray(content)) {
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (block === undefined || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        toolCalls.push({ tool: decodeAnthropicToolName(block.name), input: asRecord(block.input) ?? {} });
      }
    }
  }
  const usageRecord = asRecord(root.usage);
  const inputTokens = typeof usageRecord?.input_tokens === "number" ? usageRecord.input_tokens : 0;
  const outputTokens = typeof usageRecord?.output_tokens === "number" ? usageRecord.output_tokens : 0;
  const usage = usageRecord === undefined ? undefined : { totalTokens: inputTokens + outputTokens };
  const outText = textBlocks.join("");
  return { toolCalls, ...(outText.length > 0 ? { text: outText } : {}), ...(usage !== undefined ? { usage } : {}) };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    opts: { maxTokens?: number; baseUrl?: string } = {},
  ) {
    this.maxTokens = opts.maxTokens ?? 4096;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async decide(
    req: DecideRequest,
  ): Promise<{ toolCalls: MCPRequest[]; text?: string; usage?: { totalTokens?: number } }> {
    // PROMPT CACHING: the tools (~50k tokens) + system prompt are byte-identical on
    // every call in a turn (and across turns within the 5-min TTL). Mark a cache
    // breakpoint at the end of that static prefix so repeated calls read it at ~10%
    // of the input cost. The dynamic user message comes AFTER the breakpoint (order
    // is tools → system → messages) and is never cached. A breakpoint on the last
    // tool caches the whole tools block; one on system caches the system too.
    const tools = req.tools.map((t) => ({
      name: encodeAnthropicToolName(t.name),
      description: t.description,
      input_schema: t.input_schema,
    })) as Array<Record<string, unknown>>;
    if (tools.length > 0) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
    }
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildAnthropicUserMessage(req) }],
      tools,
    });
    const headers = JSON.stringify({
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    // Retry only TRANSPORT failures ("http post: error sending request …" — a
    // transient network blip on a large multi-call turn). API errors (auth, rate
    // limit, bad request) come back as a parsed `anthropic: …` error and must NOT
    // be retried. Bounded with a short backoff so one flaky send doesn't kill a turn.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await ops.op_http_post_headers(`${this.baseUrl}/v1/messages`, body, headers);
        return parseAnthropicMessagesResponse(raw);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.startsWith("http post:")) throw e; // API/parse error — do not retry
        if (attempt < 2) await ops.op_sleep_ms(500 * (attempt + 1));
      }
    }
    throw lastErr;
  }
}
