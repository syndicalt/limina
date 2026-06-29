// Phase 15 (Track C — Complete) — THE COMPOSITION GATE: a deterministic vertical slice that
// proves the new Track-C primitives work TOGETHER (the archetype demos' core, in miniature).
//
// Scenario "Hold the Keep": architecture.building raises a keep to defend; an intro CUTSCENE plays;
// the AI DIRECTOR paces waves; on each "peak" directive a defender casts a volley ABILITY — which
// is correctly gated by its cooldown, so a peak that arrives while the volley is recharging is
// skipped. The whole loop is driven off one sim-tick clock and must be byte-identical across runs.
//
// This is exactly what an archetype demo validates (primitives composing into a coherent, replayable
// loop), proven headlessly. Run: ./target/release/limina js/test/p15_archetype_slice.ts (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_archetype_slice FAIL: " + msg);
}
function res(label: string, r: MCPResponse | undefined): Record<string, unknown> {
  if (r === undefined || !r.success) throw new Error(`p15_archetype_slice: ${label} failed: ${JSON.stringify(r?.error ?? "no response")}`);
  return (r.result ?? {}) as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
const PERMS = resolveProfile("builder.readWrite");
const CFG = { buildRate: 0.25, fadeRate: 0.3, sustainTicks: 2, restTicks: 2, peakLevel: 1, restLevel: 0.1, pressureDamping: 0.9 };

/** Author + run the slice and return a compact, ordered event log (the deterministic trace). */
async function runSlice(session: string): Promise<{ log: string[]; keepEntities: number }> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core: CoreSkills = registerCoreSkills(reg);
  const world = makeWorld(ops);
  const at = (t: number): InvokeBase => ({ agentId: "agt", sessionId: session, permissions: PERMS, tick: t, world });

  // ── AUTHOR: a keep to defend, an intro cutscene, a defender ability, a paced director. ──────
  const keep = res("architecture.building", await reg.invoke("architecture.building", { position: [0, 0, 0], width: 8, depth: 8, height: 4 }, at(0)));
  res("cutscene.define", await reg.invoke("cutscene.define", { id: "intro", keyframes: [
    { atTick: 0, action: { type: "gates_close" } }, { atTick: 5, action: { type: "war_horn" } },
  ] }, at(0)));
  res("stats.create", await reg.invoke("stats.create", { entity: "defender", stats: [{ name: "stamina", value: 100, maxValue: 100, minValue: 0 }] }, at(0)));
  res("ability.define", await reg.invoke("ability.define", { id: "volley", cooldownTicks: 20, resourceStat: "stamina", cost: 10 }, at(0)));
  res("cutscene.play", await reg.invoke("cutscene.play", { id: "intro", startTick: 0 }, at(0)));
  res("director.configure", await reg.invoke("director.configure", CFG, at(0)));
  res("director.start", await reg.invoke("director.start", {}, at(0)));

  const cut = core.cutscene.cutsceneManager;
  const dir = core.director.directorManager;
  const log: string[] = [];

  // ── DRIVE: one sim-tick clock pumps cutscene + director; peaks trigger a (cooldown-gated) volley.
  for (let t = 1; t <= 40; t++) {
    for (const f of cut.tick(t)) log.push(`${t} intro:${f.action.type}`);
    const d = dir.tick(t, 0);
    if (d !== null) {
      log.push(`${t} director:${d.type}`);
      if (d.type === "peak") {
        const c = (await reg.invoke("ability.cast", { entity: "defender", id: "volley" }, at(t))).result as { ok: boolean; reason?: string };
        log.push(`${t} volley:${c.ok ? "FIRED" : "blocked"}`);
      }
    }
  }
  return { log, keepEntities: keep.entityCount as number };
}

const A = await runSlice("ses_p15_slice_A");

// The keep was built from skills.
assert(A.keepEntities === 8, `the keep is an 8-part building (got ${A.keepEntities})`);

// The intro cutscene fired its beats at the authored ticks, composed into the live loop.
// The loop's first pump is at t=1, so the atTick-0 beat fires then (elapsed 1 ≥ 0); the atTick-5
// beat fires at the first pump with elapsed ≥ 5, i.e. t=5.
assert(A.log.includes("1 intro:gates_close"), "intro gates_close fires at tick 1 (first pump, elapsed ≥ 0)");
assert(A.log.includes("5 intro:war_horn"), "intro war_horn fires at tick 5 (elapsed 5)");

// The director peaked on its cadence, and each peak attempted a volley.
const peaks = A.log.filter((l) => l.endsWith("director:peak")).map((l) => parseInt(l, 10));
assert(peaks.length >= 3, `the director peaked at least 3 times over 40 ticks (got ${peaks.length}: ${peaks.join(",")})`);

// COOLDOWN COMPOSITION: the volley FIRES on the first peak, is BLOCKED on the next peak (only ~11
// ticks later, inside the 20-tick cooldown), then FIRES again once enough peaks have spaced out.
const volleys = A.log.filter((l) => l.includes("volley:"));
assert(volleys[0].endsWith("FIRED"), "the first peak fires the volley: " + volleys[0]);
assert(volleys[1].endsWith("blocked"), "the second peak (inside cooldown) is blocked: " + volleys[1]);
assert(volleys.some((v) => v.endsWith("FIRED") && v !== volleys[0]), "a later, well-spaced peak fires the volley again");

// REPLAY-DETERMINISM: the whole composed slice is byte-identical across an independent run.
const B = await runSlice("ses_p15_slice_B");
assert(A.log.length === B.log.length, `same event count across runs (${A.log.length} vs ${B.log.length})`);
for (let i = 0; i < A.log.length; i++) assert(A.log[i] === B.log[i], `event ${i} identical across runs: "${A.log[i]}" vs "${B.log[i]}"`);

ops.op_log(
  "p15_archetype_slice OK: the Track-C primitives COMPOSE deterministically — architecture builds the keep, " +
  "the cutscene's beats fire on the live loop's clock, the director paces peaks, and each peak casts a volley " +
  "that the ability cooldown correctly gates (fire → blocked → fire). The whole slice replays byte-identically. " +
  `(${A.log.length} ordered events, ${peaks.length} peaks.)`,
);
