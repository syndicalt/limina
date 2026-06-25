// Phase 3 showcase core: deterministic checks for the provider, scheduler
// budget shape, and metrics helpers used by the windowed graphical showcase.

import { ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import type { DecideRequest } from "../src/agents/llm.ts";
import {
  arenaReturnImpulse,
  createShowcaseScheduler,
  percentile,
  ShowcaseProvider,
  sumQueues,
} from "../src/demos/phase3_showcase_core.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const provider = new ShowcaseProvider({ latencyEvery: 0 });
const decision = await provider.decide({
  systemPrompt: "pursue visual anchors",
  perception: {
    selfId: "agt_showcase_00",
    selfEntity: "ent_self",
    position: [0, 0.5, 0],
    nearby: [{ id: "ent_target", position: [3, 0.5, 4], distance: 5 }],
    recentEvents: [],
    tick: 12,
  },
  tools: [],
  previousResults: [],
} satisfies DecideRequest);

assert(decision.toolCalls.length === 4, "showcase provider should emit enough calls to exercise scheduler caps");
assert(decision.toolCalls[0].tool === "agent.getPerception", "first showcase call should refresh perception");
assert(decision.toolCalls.some((call) => call.tool === "physics.applyImpulse"), "showcase provider should move the player");
assert(decision.toolCalls.some((call) => call.tool === "scene.queryEntities"), "showcase provider should exercise spatial scene query");
assert(provider.decisionLatenciesMs.length === 1, "showcase provider should record decision latency");

const noTarget = await provider.decide({
  systemPrompt: "pursue visual anchors",
  perception: {
    selfId: "agt_showcase_01",
    selfEntity: "ent_self",
    position: [0, 0.5, 0],
    nearby: [],
    recentEvents: [],
    tick: 13,
  },
  tools: [],
  previousResults: [],
} satisfies DecideRequest);
assert(noTarget.toolCalls.every((call) => call.tool !== "physics.applyImpulse"), "provider should not impulse without a target");

const anchoredProvider = new ShowcaseProvider({
  latencyEvery: 0,
  targetEntityIds: ["ent_anchor"],
  impulseStrength: 0.2,
  arrivalRadius: 1.25,
});
const anchoredDecision = await anchoredProvider.decide({
  systemPrompt: "pursue visual anchors",
  perception: {
    selfId: "agt_showcase_02",
    selfEntity: "ent_self",
    position: [0, 0.5, 0],
    nearby: [
      { id: "ent_other_player", position: [0.5, 0.5, 0], distance: 0.5 },
      { id: "ent_anchor", position: [4, 0.5, 0], distance: 4 },
    ],
    recentEvents: [],
    tick: 14,
  },
  tools: [],
  previousResults: [],
} satisfies DecideRequest);
const anchoredImpulse = anchoredDecision.toolCalls.find((call) => call.tool === "physics.applyImpulse");
assert(anchoredImpulse !== undefined, "anchored provider should pursue configured anchor even when another player is closer");
assert(JSON.stringify(anchoredImpulse.input) === JSON.stringify({ entity: "ent_self", impulse: [0.2, 0, 0] }), "anchored impulse should point toward configured anchor");

const arrivedDecision = await anchoredProvider.decide({
  systemPrompt: "pursue visual anchors",
  perception: {
    selfId: "agt_showcase_03",
    selfEntity: "ent_self",
    position: [3.1, 0.5, 0],
    nearby: [{ id: "ent_anchor", position: [4, 0.5, 0], distance: 0.9 }],
    recentEvents: [],
    tick: 15,
  },
  tools: [],
  previousResults: [],
} satisfies DecideRequest);
assert(arrivedDecision.toolCalls.every((call) => call.tool !== "physics.applyImpulse"), "provider should stop applying impulses inside arrival radius");
assert(arenaReturnImpulse(2, 2) === undefined, "arena return should not affect agents inside the soft radius");
assert(JSON.stringify(arenaReturnImpulse(10, 0, 9, 0.5)) === JSON.stringify([-0.5, 0, 0]), "arena return should push outer agents inward");

const scheduler = createShowcaseScheduler();
const agents = new AgentRegistry();
agents.add({
  id: "agt_a",
  type: "player",
  entityId: "ent_a",
  profile: "player.limited",
  sessionId: "ses_showcase",
  llm: { provider: "showcase", model: "scripted", systemPrompt: "a" },
});
agents.add({
  id: "agt_b",
  type: "player",
  entityId: "ent_b",
  profile: "player.limited",
  sessionId: "ses_showcase",
  llm: { provider: "showcase", model: "scripted", systemPrompt: "b" },
});
agents.get("agt_a")?.queue.push({ req: { tool: "agent.getPerception", input: {} }, decisionId: "evt_a" });
agents.get("agt_b")?.queue.push({ req: { tool: "agent.getPerception", input: {} }, decisionId: "evt_b" });

assert(sumQueues(agents) === 2, "sumQueues should count queued showcase actions");
assert(scheduler.agentBudget(agents.all()[0]).maxQueueDepth === 3, "showcase scheduler should use finite queue depth");
assert(scheduler.agentBudget(agents.all()[0]).maxToolCallsPerDecision === 3, "showcase scheduler should cap provider tool calls");
assert(percentile([9, 1, 5, 3], 50) === 3, "percentile should sort samples deterministically");

ops.op_log("P3 showcase core OK: provider, scheduler budget, and metrics helpers verified");
