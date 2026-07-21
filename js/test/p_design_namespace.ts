// K5 GATE -- design.* command namespace.
// Proves design artifacts are first-class recorded state in the unified world log:
// design.set/patch are ordinary recorded SkillCommands, design.get is read-only, replay
// reconstructs the same design store, and AuthoritativeServer boot rehydrate rebuilds it
// from the durable log without new command kinds.
//
// Run: ./target/release/limina js/test/p_design_namespace.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import { GameDesignSpecSchema } from "../src/game/gds.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../src/game/design-direction.ts";
import { DEFAULT_WORLD_BIBLE } from "../src/game/world-bible.ts";
import { DEFAULT_CAST } from "../src/game/cast.ts";
import { DEFAULT_STORYBOARD } from "../src/game/storyboard.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import type { DesignArtifactKind } from "../src/world/design-artifacts.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_namespace FAIL: " + message);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function designValue(world: WorldContext, artifact: DesignArtifactKind): unknown {
  const store = world.design;
  assert(store !== undefined, "world has no design store");
  return store.artifacts.get(artifact);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

async function mustInvoke(
  server: AuthoritativeServer,
  tool: string,
  input: Record<string, unknown>,
  tick: number,
): Promise<unknown> {
  const response = await server.registry.invoke(tool, input, {
    agentId: "p_design_namespace_author",
    sessionId: "p_design_namespace_session",
    permissions: resolveProfile("builder.readWrite"),
    tick,
    world: server.world,
  });
  assert(response.success, `${tool} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

const validGds = clone(RELIC_SPRINT);
const ctx = createHeadlessContext({
  session: "p_design_namespace_record",
  record: {},
});

// (a) design.set with a valid GDS records exactly one skill command and stores canonical/defaulted data.
const setResult = await ctx.registry.invoke("design.set", { artifact: "gds", value: validGds }, ctx.base);
assert(setResult.success, `design.set(valid gds) failed: ${JSON.stringify(setResult.error)}`);
assert(ctx.recorder !== undefined, "recording context must expose a recorder");
assert(ctx.recorder.commandCount === 1, `design.set should record exactly one command, got ${ctx.recorder.commandCount}`);
assert(ctx.recorder.commands[0].kind === "skill" && ctx.recorder.commands[0].tool === "design.set",
  "design.set must be recorded as a normal skill command");
const afterSet = designValue(ctx.world, "gds");
assert(typeof afterSet === "object" && afterSet !== null, "design store did not hold the gds object");
assert(json(afterSet) === json(GameDesignSpecSchema.parse(validGds)),
  "design store did not hold the schema-canonical GDS value");

// (b) invalid GDS is rejected by validation and leaves the store and command count unchanged.
const beforeInvalidStore = json(designValue(ctx.world, "gds"));
const beforeInvalidCommands = ctx.recorder.commandCount;
const invalidGds = clone(validGds) as Record<string, unknown>;
delete invalidGds.winCondition;
const invalidResult = await ctx.registry.invoke("design.set", { artifact: "gds", value: invalidGds }, ctx.base);
assert(!invalidResult.success, "design.set(invalid gds) must be rejected");
assert(invalidResult.error?.message.includes("gds"), `invalid error should mention gds: ${JSON.stringify(invalidResult.error)}`);
assert(ctx.recorder.commandCount === beforeInvalidCommands,
  `failed design.set should not remain recorded (${ctx.recorder.commandCount} vs ${beforeInvalidCommands})`);
assert(json(designValue(ctx.world, "gds")) === beforeInvalidStore, "invalid design.set changed the stored GDS");

// (c) design.patch deep-merges into the current artifact and revalidates/canonicalizes.
const patchResult = await ctx.registry.invoke("design.patch", {
  artifact: "gds",
  patch: {
    pitch: "Patched design pitch",
    mechanics: [{ id: "dash", name: "Dash", skill: "player.move" }],
  },
}, ctx.base);
assert(patchResult.success, `design.patch(existing gds) failed: ${JSON.stringify(patchResult.error)}`);
const afterPatch = designValue(ctx.world, "gds") as { pitch: string; mechanics: Array<{ id: string }> };
assert(afterPatch.pitch === "Patched design pitch", "design.patch did not update a scalar field");
assert(afterPatch.mechanics.length === 1 && afterPatch.mechanics[0].id === "dash", "design.patch did not merge the mechanics array");
assert(ctx.recorder.commandCount === beforeInvalidCommands + 1,
  `design.patch should add one recorded command, got ${ctx.recorder.commandCount}`);

// Patch into an unset schema-backed artifact uses that artifact's default seed, then validates.
const ddPatch = await ctx.registry.invoke("design.patch", {
  artifact: "artDirection",
  patch: { id: "k5-art-direction", referenceLibrary: ["props.camp.signal-fire"] },
}, ctx.base);
assert(ddPatch.success, `design.patch(unset artDirection) failed: ${JSON.stringify(ddPatch.error)}`);
const artDirection = designValue(ctx.world, "artDirection") as { id: string; style: string; palette: unknown[] };
assert(artDirection.id === "k5-art-direction", "artDirection patch did not apply over the default seed");
assert(artDirection.style === DEFAULT_DESIGN_DIRECTION.style && artDirection.palette.length === DEFAULT_DESIGN_DIRECTION.palette.length,
  "artDirection patch did not preserve canonical default fields");

// Newly schema-backed K5 design artifacts: valid set canonicalizes, invalid set rejects.
async function assertDesignArtifactSchemaBacked(
  artifact: "worldBible" | "cast" | "storyboard",
  validValue: Record<string, unknown>,
  invalidValue: Record<string, unknown>,
  invalidNeedle: string,
): Promise<void> {
  const valid = await ctx.registry.invoke("design.set", { artifact, value: validValue }, ctx.base);
  assert(valid.success, `design.set(valid ${artifact}) failed: ${JSON.stringify(valid.error)}`);
  assert(json(designValue(ctx.world, artifact)) === json((valid.result as { value: unknown }).value),
    `design.set(valid ${artifact}) did not return the canonical stored value`);

  const beforeInvalid = json(designValue(ctx.world, artifact));
  const beforeInvalidCount = ctx.recorder!.commandCount;
  const invalid = await ctx.registry.invoke("design.set", { artifact, value: invalidValue }, ctx.base);
  assert(!invalid.success, `design.set(invalid ${artifact}) must be rejected`);
  assert(invalid.error?.message.includes(invalidNeedle),
    `invalid ${artifact} error should mention ${invalidNeedle}: ${JSON.stringify(invalid.error)}`);
  assert(ctx.recorder!.commandCount === beforeInvalidCount,
    `failed ${artifact} design.set should not remain recorded (${ctx.recorder!.commandCount} vs ${beforeInvalidCount})`);
  assert(json(designValue(ctx.world, artifact)) === beforeInvalid, `invalid design.set changed stored ${artifact}`);
}

const invalidWorldBible = clone(DEFAULT_WORLD_BIBLE) as Record<string, unknown>;
((invalidWorldBible.locations as Array<Record<string, unknown>>)[0]).regionId = "missing-region";
await assertDesignArtifactSchemaBacked("worldBible", clone(DEFAULT_WORLD_BIBLE) as Record<string, unknown>, invalidWorldBible, "worldBible");

const invalidCast = clone(DEFAULT_CAST) as Record<string, unknown>;
((invalidCast.npcs as Array<Record<string, unknown>>)[0]).id = (invalidCast.player as Record<string, unknown>).id;
await assertDesignArtifactSchemaBacked("cast", clone(DEFAULT_CAST) as Record<string, unknown>, invalidCast, "cast");

const invalidStoryboard = clone(DEFAULT_STORYBOARD) as Record<string, unknown>;
((invalidStoryboard.beats as Array<Record<string, unknown>>)).push({ ...((invalidStoryboard.beats as Array<Record<string, unknown>>)[0]), title: "Duplicate beat" });
await assertDesignArtifactSchemaBacked("storyboard", clone(DEFAULT_STORYBOARD) as Record<string, unknown>, invalidStoryboard, "storyboard");

// (f) design.get is read-only: it returns the artifact and does not change command count.
const beforeGetCommands = ctx.recorder.commandCount;
const getResult = await ctx.registry.invoke("design.get", { artifact: "gds" }, ctx.base);
assert(getResult.success, `design.get failed: ${JSON.stringify(getResult.error)}`);
assert(json((getResult.result as { artifact: string; value: unknown }).value) === json(designValue(ctx.world, "gds")),
  "design.get returned a value different from the store");
assert(ctx.recorder.commandCount === beforeGetCommands,
  `design.get must not be recorded (${ctx.recorder.commandCount} vs ${beforeGetCommands})`);

// (d) replay the recorded skill stream into a fresh world; it reconstructs the same design store.
const replayed = await replayCommands(ctx.recorder.commands.map((cmd) => clone(cmd)), {
  makeWorld: () => createHeadlessContext({ session: "p_design_namespace_replay" }).world,
  makeRegistry: (tracer) => createHeadlessContext({ session: "p_design_namespace_replay", tracer: tracer as LiminaTracer }).registry,
});
assert(replayed.commands === ctx.recorder.commandCount, "replay did not consume every recorded command");
assert(json(designValue(replayed.world, "gds")) === json(designValue(ctx.world, "gds")),
  "replayed GDS store does not match the recorded world");
assert(json(designValue(replayed.world, "artDirection")) === json(designValue(ctx.world, "artDirection")),
  "replayed artDirection store does not match the recorded world");

// (e) A second AuthoritativeServer on the same durable log rehydrates the design artifact.
const LOG_NAME = "p_design_namespace_worldlog.jsonl";
ops.op_write_trace(LOG_NAME, "");
const first = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p_design_namespace_server",
  seed: 0x5,
  tickMs: 1000,
  worldLog: { name: LOG_NAME },
});
await first.ready;
await mustInvoke(first, "design.set", { artifact: "gds", value: validGds }, 1);
const firstServerGds = json(designValue(first.world, "gds"));
await first.shutdown();

const persisted = parseWorldLog(ops.op_read_trace(LOG_NAME)).commands;
assert(persisted.some((cmd) => cmd.kind === "skill" && cmd.tool === "design.set"),
  "durable log does not contain the design.set SkillCommand");

const second = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p_design_namespace_server",
  seed: 0x5,
  tickMs: 1000,
  worldLog: { name: LOG_NAME },
});
await second.ready;
assert(second.rehydrated, "second server did not mark the durable log as rehydrated");
assert(json(designValue(second.world, "gds")) === firstServerGds,
  "AuthoritativeServer boot rehydrate did not reconstruct the design store");
await second.shutdown();

ops.op_log(
  "p_design_namespace OK: design.set records one SkillCommand and stores canonical GDS; invalid GDS is rejected with store unchanged; design.patch deep-merges and revalidates, including default-seeded artDirection; worldBible/cast/storyboard design.set now accept valid canonical artifacts and reject invalid schema/semantic values; replayCommands reconstructs the design store; AuthoritativeServer durable boot rehydrates it; design.get is read-only and unrecorded.",
);
