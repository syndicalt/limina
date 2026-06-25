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
}

export interface LLMProvider {
  readonly name: string;
  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage?: { totalTokens?: number } }>;
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
