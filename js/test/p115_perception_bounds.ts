import { AgentRegistry } from "../src/agents/agent.ts";
import { MAX_PERCEPTION_ENTITIES, perceptionSystem } from "../src/agents/systems.ts";
import { installOps, ops, type EngineOps } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/context.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p115_perception_bounds FAIL: ${message}`);
}

const agents = new AgentRegistry();
const ctx = createHeadlessContext({
  session: "ses_p115_perception",
  agentId: "agt_builder",
  agents,
  spatial: new UniformGridSpatialIndex({ cellSize: 8 }),
});
ops.op_physics_create_world(0);

const ids: string[] = [];
for (let index = 0; index < 600; index++) {
  const result = await ctx.registry.invoke("scene.createEntity", {
    position: [index % 20, Math.floor(index / 400), Math.floor(index / 20) % 20],
  }, ctx.base);
  assert(result.success, `fixture entity ${index} failed`);
  ids.push((result.result as { entity: string }).entity);
}
agents.add({
  id: "agt_dense",
  type: "player",
  entityId: ids[0],
  perceptionRadius: 50,
  decisionIntervalTicks: 1,
  profile: "player.limited",
  sessionId: "ses_p115_perception",
  llm: { provider: "scripted", model: "", systemPrompt: "bounded" },
});

const native = ops;
const buffers: Array<{ ordered: ArrayBufferLike; queries: ArrayBufferLike; out: ArrayBufferLike; outLength: number }> = [];
const wrapped = Object.create(native) as EngineOps;
wrapped.op_ecs_spatial_query_batch = (px, py, pz, ordered, cellSize, queries, maxHits, out): void => {
  assert(maxHits === MAX_PERCEPTION_ENTITIES, `native maxHits was ${maxHits}`);
  buffers.push({ ordered: ordered.buffer, queries: queries.buffer, out: out.buffer, outLength: out.length });
  native.op_ecs_spatial_query_batch(px, py, pz, ordered, cellSize, queries, maxHits, out);
};
installOps(wrapped, { ecsSpatialQueryBatch: true });
try {
  perceptionSystem(agents, ctx.world, ctx.tracer, 1);
  perceptionSystem(agents, ctx.world, ctx.tracer, 2);
} finally {
  installOps(native, { ecsSpatialQueryBatch: true });
}

const nearby = agents.get("agt_dense")?.perception?.nearby;
assert(nearby?.length === MAX_PERCEPTION_ENTITIES, `dense perception returned ${nearby?.length} entities`);
assert(buffers.length === 2, `expected two native batches, got ${buffers.length}`);
assert(buffers[0].outLength === MAX_PERCEPTION_ENTITIES + 1,
  `output scratch scaled with world history (${buffers[0].outLength}) instead of the perception cap`);
assert(buffers[0].ordered === buffers[1].ordered && buffers[0].queries === buffers[1].queries && buffers[0].out === buffers[1].out,
  "unchanged sweeps did not reuse batch buffers");

ops.op_log(`p115_perception_bounds OK: ${ids.length}-entity dense world returns nearest ${MAX_PERCEPTION_ENTITIES}, bounded output, scratch reused`);
