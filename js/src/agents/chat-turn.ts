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
  "You start with a small CORE set of world-building skills plus discovery skills. If you need a capability that is not in your current tool list, call skills.search(query) to find the skill, then skills.describe(name) to get its exact input schema, then call it. Do not guess a skill's arguments — describe it first.",
  "SCOPE + STOP: Do EXACTLY what the user asked and NOTHING more, with the FEWEST tool calls. The existing scene is only context — it is NOT a project for you to extend or 'flesh out'. Never add entities, props, buildings, lighting, terrain, or decoration the user did not explicitly request, and never decide on your own to 'continue building' the scene. The instant the request is satisfied, STOP calling tools and end the turn — leftover step budget is NOT permission to keep working.",
  "Do NOT inspect or query the scene unless the request genuinely depends on existing state (e.g. 'put it next to the well'). For a self-contained request like 'create a red sphere', just create it — no inspection, no follow-up work.",
  "Do not narrate a running step-by-step plan. Act with your tool calls, then reply with ONE short sentence describing what you did. If the request is ambiguous, do the minimal reasonable thing (or ask) rather than building extra.",
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
      // Advertise only the small core surface (+ discovery skills) each step — keeps
      // the request tiny/cheap; the agent finds + invokes the rest via skills.search.
      toolMode: "bootstrap",
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
