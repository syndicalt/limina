import type { Tracer } from "../observability/event.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import type { AgentRecord } from "./agent.ts";
import { runBoundedMultiTurn, type ProviderMap } from "./systems.ts";

export interface ChatTurnMessage {
  turnId: string;
  text: string;
  attachments?: unknown;
}

export type ChatTurnPush =
  | { type: "chat.delta"; turnId: string; text: string }
  | { type: "chat.step"; turnId: string; tool: string; label: string; icon?: string }
  | { type: "chat.done"; turnId: string; reply: string }
  | { type: "chat.error"; turnId: string; message: string };

export interface ChatTurnPersistRecord {
  ts: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  text?: string;
  event?: ChatTurnPush;
}

export interface RunChatTurnOptions {
  registry: SkillRegistry;
  world: WorldContext;
  providers: ProviderMap;
  tracer: Tracer;
  msg: ChatTurnMessage;
  push(message: ChatTurnPush): void | Promise<void>;
  persist?(record: ChatTurnPersistRecord): void | Promise<void>;
  limits?: {
    maxSteps?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    maxTokens?: number;
  };
}

const SYSTEM_PROMPT = [
  "You are Limina's live world-build agent, co-authoring a live 3D scene with a human.",
  "You receive the human's request as a plain \"User request:\" message. Treat it as a direct instruction to act on right now.",
  "To change the world you MUST call the available skills (e.g. scene.createEntity, terrain.generateRegion, three.setMaterial, player.spawn). Acknowledging or describing the plan is NOT enough — when the request is a world edit, emit the actual tool call(s) in THIS turn. Never say you will do something without also calling the skill that does it.",
  "Author the scene only through skills; do not invent state outside the tool results. Use sensible defaults for anything unspecified (place near the origin, modest size).",
  "SCOPE DISCIPLINE: do EXACTLY what is asked and no more. If the user asks for one box, create exactly one box and STOP — do not add extra entities, terrain, lighting, or decoration they did not request. Match the number and kind of things to the request; when in doubt, do the minimal thing and ask what to add next.",
  "After the tool calls succeed, briefly describe what you authored. Keep chat concise.",
].join("\n");

function safeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return cleaned.length === 0 ? "turn" : cleaned;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function maybePersist(
  persist: RunChatTurnOptions["persist"],
  record: Omit<ChatTurnPersistRecord, "ts">,
): Promise<void> {
  if (persist === undefined) return;
  await persist({ ts: new Date().toISOString(), ...record });
}

async function pushAndPersist(
  push: RunChatTurnOptions["push"],
  persist: RunChatTurnOptions["persist"],
  turnId: string,
  message: ChatTurnPush,
): Promise<void> {
  await push(message);
  await maybePersist(persist, { turnId, role: "system", event: message });
}

export async function runChatTurn(opts: RunChatTurnOptions): Promise<string> {
  const turnId = opts.msg.turnId;
  const agentId = `agt_chat_${safeId(turnId)}`;
  const sessionId = `chat_${safeId(turnId)}`;
  const textParts: string[] = [];
  let pushQueue = Promise.resolve();
  const enqueuePush = (message: ChatTurnPush): void => {
    pushQueue = pushQueue.then(() => pushAndPersist(opts.push, opts.persist, turnId, message));
  };

  await maybePersist(opts.persist, { turnId, role: "user", text: opts.msg.text });
  opts.tracer.emit({
    type: `chat.user: ${opts.msg.text}`,
    actorId: agentId,
    threadId: sessionId,
    parentEventId: null,
    causedBy: [],
    payload: { turnId, text: opts.msg.text, attachments: opts.msg.attachments },
  });

  const agent: AgentRecord = {
    id: agentId,
    type: "builder",
    perceptionRadius: 100,
    decisionIntervalTicks: 1,
    profile: "builder.readWrite",
    sessionId,
    llm: { provider: "anthropic", model: "anthropic", systemPrompt: SYSTEM_PROMPT },
    inFlight: false,
    lastDecisionTick: -1,
    queue: [],
  };

  try {
    await runBoundedMultiTurn(agent, opts.registry, opts.providers, opts.world, opts.tracer, {
      startTick: 0,
      maxSteps: opts.limits?.maxSteps ?? 8,
      maxToolCalls: opts.limits?.maxToolCalls ?? 16,
      timeoutMs: opts.limits?.timeoutMs ?? 60_000,
      // Token BUDGET (cumulative usage), not the model's output cap. A live world
      // tool surface is large (~195 skills ⇒ ~50k input tokens PER step), so a small
      // budget trips `token_budget` and returns BEFORE the first tool call executes.
      // Keep a generous runaway backstop; maxSteps/maxToolCalls/timeout do the real bounding.
      maxTokens: opts.limits?.maxTokens ?? 2_000_000,
      onText: (text) => {
        textParts.push(text);
        enqueuePush({ type: "chat.delta", turnId, text });
      },
      onStep: (step) => {
        enqueuePush({
          type: "chat.step",
          turnId,
          tool: step.tool,
          label: step.label,
          icon: step.icon,
        });
      },
      onError: (err) => {
        enqueuePush({
          type: "chat.error",
          turnId,
          message: errorMessage(err),
        });
      },
    });
    const reply = textParts.join("\n");
    await pushQueue;
    await maybePersist(opts.persist, { turnId, role: "assistant", text: reply });
    await pushAndPersist(opts.push, opts.persist, turnId, { type: "chat.done", turnId, reply });
    return reply;
  } catch (err) {
    const message = errorMessage(err);
    await pushQueue;
    await pushAndPersist(opts.push, opts.persist, turnId, { type: "chat.error", turnId, message });
    return textParts.join("\n");
  }
}

export function chatTurnPermissions(): ReadonlySet<string> {
  return resolveProfile("builder.readWrite");
}
