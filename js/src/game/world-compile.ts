// World-slice compiler (GDS doc -> live world). Turns a GDS `world` slice into live entities by
// driving the existing authoring skills IN PLACEMENT ORDER, threading each placement's resulting
// entity id so a material override targets the entity the create/place call just made — a static
// command array cannot express that backreference, which is why this is an awaited invoke sequence.
// It returns the placement-id -> entity-id map (the inverse the capture/undo directions need) plus
// per-placement outcomes. Like content.ts `placeContent`, a per-placement failure is COLLECTED, not
// thrown: one bad placement never aborts the whole world.
//
// First cut (this file): player/prop ENTITY placements (player.spawn / scene.createEntity), CONTENT
// placements (asset.place), full transform (position via the create call; scale + rotation as
// residual ecs.updateComponent edits for entity placements, or baked into asset.place for content),
// and material overrides. Terrain/lighting preset resolution and the export/package tail are
// strictly additive on top (see the compile plan) and intentionally out of scope here.

import type { GameDesignSpec, Placement } from "./gds.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import { applyAuthorCommand, applyAuthorCommands, type ApplyOptions } from "../kernel/authoring.ts";
import { translateManipulation } from "../kernel/manipulation.ts";
import { eulerToQuaternion } from "../kernel/math.ts";
import { EntityTable, ops, type EngineOps } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { WorldRecorder } from "../worldlog/recorder.ts";
import { captureWorldState, getInstalledSkillRng, type WorldStateSnapshot } from "../worldlog/log.ts";
import { exportGame, canExport } from "./publish.ts";
import type { ExportFiles } from "../export/package.ts";

export interface WorldCompileResult {
  /** placement.id -> the live `ent_` id it produced. The mapping capture + undo need. */
  placementToEntity: Map<string, string>;
  /** Per-placement failures (id + reason). Compilation continues past a soft failure. */
  failures: { id: string; reason: string }[];
  /** Count of placements that produced a live entity. */
  placed: number;
}

const isIdentityScale = (s: readonly number[]): boolean => s[0] === 1 && s[1] === 1 && s[2] === 1;
const isZeroRotation = (r: readonly number[]): boolean => r[0] === 0 && r[1] === 0 && r[2] === 0;
const vec3 = (v: readonly number[]): [number, number, number] => [v[0], v[1], v[2]];

function entityOf(res: MCPResponse, placementId: string, tool: string): string {
  if (!res.success) throw new Error(`${tool} failed: ${JSON.stringify(res.error)}`);
  const entity = (res.result as { entity?: string } | undefined)?.entity;
  if (entity === undefined) throw new Error(`${tool} returned no entity for placement '${placementId}'`);
  return entity;
}

/** Realize one placement's base entity. Returns the entity id and whether the create call already
 *  BAKED the full transform (asset.place takes euler rotation + scale directly; player.spawn /
 *  scene.createEntity take only position, so their rotation/scale must be applied as residuals). */
async function createPlacement(
  registry: SkillRegistry,
  world: WorldContext,
  p: Placement,
  entityRole: (id: string) => string | undefined,
  contentAsset: (id: string) => string | undefined | null,
  opts: ApplyOptions,
): Promise<{ entity: string; transformBaked: boolean }> {
  if (p.entity !== undefined) {
    const role = entityRole(p.entity);
    if (role === undefined) throw new Error(`placement '${p.id}' references unknown entity '${p.entity}'`);
    if (role === "player") {
      const res = await applyAuthorCommand(registry, world,
        { kind: "skill", tool: "player.spawn", input: { position: vec3(p.transform.position) }, agentId: opts.defaultAgentId, perms: ["player.write"] }, opts);
      return { entity: entityOf(res, p.id, "player.spawn"), transformBaked: false };
    }
    const res = await applyAuthorCommand(registry, world,
      { kind: "skill", tool: "scene.createEntity", input: { shape: "box", position: vec3(p.transform.position) }, agentId: opts.defaultAgentId, perms: ["scene.write"] }, opts);
    return { entity: entityOf(res, p.id, "scene.createEntity"), transformBaked: false };
  }
  // Content placement: asset.place BY ID. The asset must be sourced (content.asset resolved) first —
  // fail LOUDLY otherwise rather than silently placing nothing.
  const asset = contentAsset(p.content as string);
  if (asset === undefined) throw new Error(`placement '${p.id}' references unknown content '${p.content}'`);
  if (asset === null) throw new Error(`content '${p.content}' has no resolved asset — source it before compiling`);
  const input: Record<string, unknown> = { assetId: asset, position: vec3(p.transform.position) };
  if (!isZeroRotation(p.transform.rotation)) input.rotation = vec3(p.transform.rotation); // asset.place takes EULER
  if (!isIdentityScale(p.transform.scale)) input.scale = vec3(p.transform.scale);
  const res = await applyAuthorCommand(registry, world,
    { kind: "skill", tool: "asset.place", input, agentId: opts.defaultAgentId, perms: ["scene.write"] }, opts);
  return { entity: entityOf(res, p.id, "asset.place"), transformBaked: true };
}

/** Author a GDS `world` slice into a live world. Reuses the SAME manipulation bridge a human edit
 *  uses for residual transform + material, so a compiled placement and a hand-placed one produce
 *  identical commands. */
export async function authorWorldSlice(
  registry: SkillRegistry,
  world: WorldContext,
  gds: GameDesignSpec,
  opts: ApplyOptions,
): Promise<WorldCompileResult> {
  const result: WorldCompileResult = { placementToEntity: new Map(), failures: [], placed: 0 };
  const slice = gds.world;
  if (slice === undefined) return result;

  const roleById = new Map(gds.entities.map((e) => [e.id, e.role] as const));
  const assetById = new Map(gds.content.map((c) => [c.id, c.asset ?? null] as const));
  const entityRole = (id: string): string | undefined => roleById.get(id);
  // undefined = unknown content id; null = known content but not yet sourced.
  const contentAsset = (id: string): string | undefined | null => (assetById.has(id) ? assetById.get(id)! : undefined);

  for (const p of slice.placements) {
    let created: { entity: string; transformBaked: boolean };
    try {
      created = await createPlacement(registry, world, p, entityRole, contentAsset, opts);
    } catch (e) {
      result.failures.push({ id: p.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    result.placementToEntity.set(p.id, created.entity);
    result.placed++;

    // Residual transform for entity placements (asset.place already baked rotation + scale).
    if (!created.transformBaked) {
      if (!isZeroRotation(p.transform.rotation)) {
        const [rx, ry, rz] = p.transform.rotation;
        const rr = await applyManipulationLike(registry, world, { kind: "rotate", entity: created.entity, quaternion: eulerToQuaternion(rx, ry, rz) }, opts);
        if (rr) result.failures.push({ id: p.id, reason: "rotation failed" });
      }
      if (!isIdentityScale(p.transform.scale)) {
        const sr = await applyManipulationLike(registry, world, { kind: "scale", entity: created.entity, scale: vec3(p.transform.scale) }, opts);
        if (sr) result.failures.push({ id: p.id, reason: "scale failed" });
      }
    }

    // Optional material override, via the SAME bridge a human material edit uses.
    if (p.material !== undefined) {
      const mr = await applyManipulationLike(registry, world, {
        kind: "material", entity: created.entity,
        material: p.material.material, roughness: p.material.roughness, metalness: p.material.metalness,
      }, opts);
      if (mr) result.failures.push({ id: p.id, reason: "material override failed" });
    }
  }
  return result;
}

// Apply a manipulation via the shared bridge; returns a failure reason flag (true = some command
// failed). Kept local so the residual/material steps read as a single soft-failable unit.
async function applyManipulationLike(
  registry: SkillRegistry,
  world: WorldContext,
  m: Parameters<typeof translateManipulation>[0],
  opts: ApplyOptions,
): Promise<boolean> {
  const responses = await applyAuthorCommands(registry, world, translateManipulation(m), opts);
  return responses.some((r) => !r.success);
}

// ── Compile the doc into a portable, runnable EXPORT bundle (the "Compile" verb) ─────────────────

export interface CompileToExportOptions {
  worldId: string;
  seed?: number;
  sessionId?: string;
  gravity?: number;
  /** Export creation marker; omit for the recorder's deterministic default. */
  createdAt?: string;
  agentId?: string;
  permissions?: ReadonlySet<string>;
}

export interface CompiledExport {
  files: ExportFiles;
  result: WorldCompileResult;
  /** State of the compiled world — the reference for a record-vs-replay bit-identity check. */
  recordedState: WorldStateSnapshot;
  /** Total recorded commands (world setup + authoring), for a loadExport round-trip assertion. */
  commandCount: number;
}

/** Compile a GDS `world` slice into a portable, runnable export bundle. Authors the slice into a
 *  fresh recorder-backed headless world, then assembles the recorded command stream into the 5-file
 *  export the browser plays back. The bundle is command-stream replay-complete (all authoring is
 *  skill-routed), so a fresh engine re-invokes the log to rebuild the world — no keyframes needed.
 *  Requires `canExport(gds)` (a direct-path game is not replay-complete).
 *
 *  Determinism note: when the SAME process will also REPLAY this bundle (a headless gate), warm THREE
 *  before calling so first-mesh lazy-init doesn't consume the seeded rng on the record pass only; a
 *  browser caller is already warm. */
export async function compileWorldToExport(gds: GameDesignSpec, opts: CompileToExportOptions): Promise<CompiledExport> {
  if (!canExport(gds)) {
    throw new Error(`compileWorldToExport: GDS '${gds.id}' opted into direct-path — not replay-complete/exportable`);
  }
  const session = opts.sessionId ?? `ses_compile_${opts.worldId}`;
  const registry = new SkillRegistry(new LiminaTracer(session));
  const core = registerCoreSkills(registry);
  const recorder = new WorldRecorder(session);
  recorder.attach(registry);                       // record top-level authoring commands
  recorder.seed(opts.seed ?? 0);
  const recOps = recorder.wrapOps(ops);
  const world = makeHeadlessWorld(recOps);
  world.rng = getInstalledSkillRng(); // the world-owned skill stream the seed installed
  recOps.op_physics_create_world(opts.gravity ?? -9.81); // recorded world setup so replay rebuilds it
  const result = await authorWorldSlice(registry, world, gds, {
    sessionId: session, tick: 0, defaultAgentId: opts.agentId ?? "human_editor", defaultPerms: opts.permissions,
  });
  const files = exportGame(recorder, { worldId: opts.worldId, createdAt: opts.createdAt, assets: core.assets.bundle() });
  return { files, result, recordedState: captureWorldState(world), commandCount: recorder.commands.length };
}

/** A headless authoring world with a stub scene (compile records a command stream + no render;
 *  the browser re-renders on playback). Mirrors the headless world the export/parity paths build. */
export function makeHeadlessWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
