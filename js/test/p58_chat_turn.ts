// P58 -- server-side live build chat turn (headless, scripted provider).
//
// A chat turn is a bounded co-located agent turn: model text streams back to the
// requesting client while tool calls author the world through the normal skills.
// This test is intentionally provider-scripted: no network, no Anthropic key.

import { ops } from "../src/engine.ts";
import { runChatTurn, type ChatTurnPush } from "../src/agents/chat-turn.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { createHeadlessContext } from "../src/game/index.ts";

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
const reply = await runChatTurn({
  registry: ctx.registry,
  world: ctx.world,
  providers: { anthropic: provider },
  tracer: ctx.registry.tracer,
  msg: { turnId: "turn_p58", text: "Build a red cube at 1,2,3." },
  limits: { timeoutMs: 1000 },
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
assert(reply.includes("Creating a red cube.") && reply.includes("The cube is in the scene."), "assembled reply text missing provider text");

ops.op_log(`p58_chat_turn OK: ${pass} assertions -- scripted chat turn streamed text/step/done and authored one entity`);
