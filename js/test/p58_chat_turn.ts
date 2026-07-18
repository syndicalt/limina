// P58 -- server-side live build chat turn (headless, scripted provider).
//
// A chat turn is a bounded co-located agent turn: model text streams back to the
// requesting client while tool calls author the world through the normal skills.
// This test is intentionally provider-scripted: no network, no Anthropic key.

import { ops } from "../src/engine.ts";
import { runChatTurn, type ChatTurnPush } from "../src/agents/chat-turn.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import type { MCPRequest, MCPResponse } from "../src/mcp/protocol.ts";
import { createHeadlessContext } from "../src/game/index.ts";

type ChatStepPush = Extract<ChatTurnPush, { type: "chat.step" }>;

let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p58_chat_turn: " + msg);
  pass++;
}

const ctx = createHeadlessContext({ session: "ses_p58_chat" });
ops.op_physics_create_world(0);

class BuildOneEntityProvider implements LLMProvider {
  readonly name = "scripted-chat";
  calls = 0;

  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; text?: string; usage?: { totalTokens?: number } }> {
    this.calls++;
    if (this.calls === 1) {
      assert(req.systemPrompt.includes("author"), "system prompt should describe authoring");
      assert(req.userMessage === "Build a red cube at 1,2,3.", "the chat text must reach the provider via req.userMessage (not only perception)");
      return Promise.resolve({
        text: "Creating a red cube.",
        toolCalls: [{
          tool: "scene.createEntity",
          input: { shape: "box", size: 1, color: 0xff0000, position: [1, 2, 3] },
        }],
        usage: { totalTokens: 7 },
      });
    }
    return Promise.resolve({ text: "The cube is in the scene.", toolCalls: [], usage: { totalTokens: 3 } });
  }
}

const pushed: ChatTurnPush[] = [];
const provider = new BuildOneEntityProvider();
const before = ctx.world.entities.ids().length;
let executorCalls = 0;
const reply = await runChatTurn({
  registry: ctx.registry,
  world: ctx.world,
  providers: { anthropic: provider },
  tracer: ctx.registry.tracer,
  msg: { turnId: "turn_p58", text: "Build a red cube at 1,2,3." },
  limits: { timeoutMs: 1000 },
  invokeTool: async (name, input, base) => {
    executorCalls++;
    return ctx.registry.invoke(name, input, base);
  },
  push: (m) => {
    pushed.push(m);
  },
});

const order = pushed.map((m) => m.type);
const firstStep = order.indexOf("chat.step");
const firstDelta = order.indexOf("chat.delta");
const done = order.indexOf("chat.done");
assert(firstStep >= 0, "chat.step was not pushed");
assert(firstDelta >= 0, "chat.delta was not pushed");
assert(done >= 0, "chat.done was not pushed");
assert(firstDelta < firstStep && firstStep < done, "expected chat.delta before chat.step before chat.done, got " + JSON.stringify(order));
assert(!order.includes("chat.error"), "chat.error should not be pushed: " + JSON.stringify(pushed));
assert(ctx.world.entities.ids().length === before + 1, "world should gain exactly one entity");
assert(executorCalls === 1, `chat must use the injected authority executor exactly once, got ${executorCalls}`);
assert(reply.includes("Creating a red cube.") && reply.includes("The cube is in the scene."), "assembled reply text missing provider text");

// D1: the successful call must ALSO push a completion step (status "ok", carrying the
// skill result) after the pending step — the chat surface renders outcomes, not hopes.
{
  const steps = pushed.filter((m): m is ChatStepPush => m.type === "chat.step");
  const pending = steps.findIndex((s) => s.tool === "scene.createEntity" && s.status === undefined);
  const done1 = steps.findIndex((s) => s.tool === "scene.createEntity" && s.status === "ok");
  assert(pending >= 0, "a pending (status-less) step precedes the invoke");
  assert(done1 > pending, "an ok completion step follows the pending step");
  assert(steps[done1].result !== undefined, "the ok completion carries the skill result");
  const doneMsg = pushed.find((m) => m.type === "chat.done");
  assert(doneMsg !== undefined && doneMsg.type === "chat.done" && doneMsg.reason === undefined,
    "a naturally-ended turn pushes chat.done WITHOUT a terminal reason");
}

// ════════ D1: failure surfacing — rejected / held / failed completions ═══════════════════
// A failed agent tool call must never read as silence: unknown tool and invalid args push
// completion-only "rejected" steps; a pending-approval outcome pushes "held" (detail =
// approvalId); a skill error pushes "failed" (detail = the error message).
class FailureModesProvider implements LLMProvider {
  readonly name = "scripted-failures";
  calls = 0;
  decide(_req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; text?: string; usage?: { totalTokens?: number } }> {
    this.calls++;
    if (this.calls === 1) {
      return Promise.resolve({
        toolCalls: [
          { tool: "no.suchSkill", input: {} },
          { tool: "scene.createEntity", input: { shape: 123 } }, // fails the input schema
          { tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0x00ff00, position: [0, 1, 0] } }, // executor holds
          { tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0x0000ff, position: [2, 1, 0] } }, // executor fails
        ],
        usage: { totalTokens: 5 },
      });
    }
    return Promise.resolve({ text: "Reported the failures.", toolCalls: [], usage: { totalTokens: 2 } });
  }
}

const pushed2: ChatTurnPush[] = [];
let realInvokes = 0;
await runChatTurn({
  registry: ctx.registry,
  world: ctx.world,
  providers: { anthropic: new FailureModesProvider() },
  tracer: ctx.registry.tracer,
  msg: { turnId: "turn_p58_failures", text: "Exercise every failure path." },
  limits: { timeoutMs: 1000 },
  invokeTool: (_name, _input, _base): Promise<MCPResponse> => {
    realInvokes++;
    if (realInvokes === 1) {
      return Promise.resolve({ success: false, error: { code: "pending_approval", message: "evt_approval_p58" } });
    }
    return Promise.resolve({ success: false, error: { code: "handler_error", message: "boom: fixture failure" } });
  },
  push: (m) => {
    pushed2.push(m);
  },
});

{
  const steps = pushed2.filter((m): m is ChatStepPush => m.type === "chat.step");
  const statuses = steps.map((s) => s.status);
  assert(JSON.stringify(statuses) === JSON.stringify(["rejected", "rejected", undefined, "held", undefined, "failed"]),
    "expected [rejected, rejected, pending, held, pending, failed] step statuses, got " + JSON.stringify(statuses));
  assert(steps[0].tool === "no.suchSkill" && (steps[0].detail ?? "").includes("unknown skill"),
    "unknown tool pushes a rejected step naming the tool + reason: " + JSON.stringify(steps[0]));
  assert(steps[1].tool === "scene.createEntity" && (steps[1].detail ?? "").includes("invalid input"),
    "invalid args pushes a rejected step with the reason: " + JSON.stringify(steps[1]));
  assert(steps[3].status === "held" && steps[3].detail === "evt_approval_p58",
    "a pending_approval outcome pushes a held step whose detail is the approvalId: " + JSON.stringify(steps[3]));
  assert(steps[5].status === "failed" && steps[5].detail === "boom: fixture failure",
    "a skill error pushes a failed step carrying the error message: " + JSON.stringify(steps[5]));
  assert(realInvokes === 2, `only the two schema-valid calls reach the executor, got ${realInvokes}`);
}

// ════════ D1: a bound-cut turn surfaces its terminal reason on chat.done ═════════════════
class NeverStopsProvider implements LLMProvider {
  readonly name = "scripted-runaway";
  decide(_req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage?: { totalTokens?: number } }> {
    return Promise.resolve({
      toolCalls: [{ tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0xffffff, position: [4, 1, 0] } }],
      usage: { totalTokens: 3 },
    });
  }
}

const pushed3: ChatTurnPush[] = [];
await runChatTurn({
  registry: ctx.registry,
  world: ctx.world,
  providers: { anthropic: new NeverStopsProvider() },
  tracer: ctx.registry.tracer,
  msg: { turnId: "turn_p58_cut", text: "Run until the step bound." },
  limits: { timeoutMs: 1000, maxSteps: 1 },
  invokeTool: (name, input, base) => ctx.registry.invoke(name, input, base),
  push: (m) => {
    pushed3.push(m);
  },
});

{
  const doneMsg = pushed3.find((m) => m.type === "chat.done");
  assert(doneMsg !== undefined && doneMsg.type === "chat.done", "the cut turn still pushes chat.done");
  assert(doneMsg.reply === "", "the cut turn produced no reply text");
  assert(doneMsg.reason === "max_steps", `a text-less bound-cut turn surfaces its terminal reason, got ${JSON.stringify(doneMsg)}`);
}

ops.op_log(`p58_chat_turn OK: ${pass} assertions -- scripted chat turn streamed text/step/done, authored one entity, and surfaced rejected/held/failed steps + the cut-turn terminal reason`);
