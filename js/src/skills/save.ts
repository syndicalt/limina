// save.*, checkpoint.* skills — save/load, checkpoints, and session persistence.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// ── ARCHITECTURE (the honest save/load spine) ────────────────────────────────
// Save/load is built on the engine's canonical durable spine, NOT a stub:
//
//   • CLOSURE STATE. The SaveManager (checkpoints + named slots) lives in the
//     closure of registerSaveSkills; every skill closes over it. (The old module-
//     level skills read `(ctx.world as any).saveManager` — never set, so every call
//     was a silent no-op. That cast is gone.)
//
//   • checkpoint.create / checkpoint.load — REAL SNAPSHOT/RESTORE. create captures
//     the authoritative comparable world state via captureWorldState (every live
//     entity's ECS Position/Rotation/Scale, body transform when body-bound) plus the
//     EntityTable identity snapshot (ids/eids/seq/version) and the agent-supplied
//     serializable gameState. load RESTORES the entity-table identity and writes the
//     captured transforms back into the SoA, and returns the gameState for the caller
//     to re-apply. NOT restored (documented, never claimed): native physics body
//     internal state, render meshes, and closure-bound game-layer managers (those are
//     re-derived by replaying their authoring skills — see the log facade below).
//
//   • save.export / save.import — TWO honest modes:
//       LOG FACADE (preferred; active when a `recorder` is wired): export serializes
//       the recorded command stream into a real portable package via assembleExport
//       (the world log IS the portable format); import loadExport-verifies it (content
//       hashes) and, given replay factories, replayCommands it into a fresh world —
//       the same anti-hack replay path the engine uses everywhere. The package
//       reconstructs by RE-RUNNING authored skills, so managers/bodies come back too.
//       SNAPSHOT FALLBACK (when no recorder is wired — the current index.ts default):
//       export serializes the REAL checkpoint snapshot (captureWorldState + identity +
//       gameState, NOT a fake "trace_data" string); import restores it into the world.
//
//   • DETERMINISM. save.export is itself a recorded command, so it must recompute
//     bit-identically on replay: NO Date.now()/new Date()/Math.random(). The export's
//     timestamp is derived from ctx.tick (deterministic), so two exports at the same
//     tick over the same state are byte-identical (the old exportedTick: Date.now()
//     made every export differ and broke replay).

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry, ExecutionContext } from "./registry.ts";
import { Position, Rotation, Scale } from "../ecs/world.ts";
import {
  captureWorldState,
  LOG_VERSION,
  type EntityState,
  type WorldCommand,
  type WorldLogMeta,
  type WorldStateSnapshot,
} from "../worldlog/log.ts";
import type { EntityTableSnapshot } from "../engine.ts";
import type { WorldRecorder } from "../worldlog/recorder.ts";
import type { ReplayDeps } from "../worldlog/replay.ts";
import { replayCommands } from "../worldlog/replay.ts";
import { assembleExport, loadExport, type ExportFiles } from "../export/package.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** Serialized-save format version (independent of LOG_VERSION; tags the wrapper). */
const SAVE_VERSION = 1;

/** A real checkpoint: the captured world state, the entity-table identity, and the
 *  agent-supplied serializable gameState — everything load needs to restore. */
export interface Checkpoint {
  name: string;
  tick: number;
  gameState: Record<string, unknown>;
  /** Per-entity ECS transforms (+ body transform when body-bound), via captureWorldState. */
  world: WorldStateSnapshot;
  /** Entity-table identity (ids/eids/bodyIds/seq/version) so restore re-issues the same ids. */
  entityTable: EntityTableSnapshot;
  createdTick: number;
}

export interface SaveSlot {
  name: string;
  data: string; // Serialized save data (a SnapshotSave or LogSave JSON wrapper).
  createdTick: number;
  gameTick: number;
  metadata: Record<string, unknown>;
}

/** SNAPSHOT-mode serialized save: the real world snapshot (no recorder wired). */
interface SnapshotSave {
  kind: "limina.save.snapshot";
  version: number;
  tick: number;
  gameState: Record<string, unknown>;
  world: WorldStateSnapshot;
  entityTable: EntityTableSnapshot;
}

/** LOG-mode serialized save: the portable export package (the durable command log). */
interface LogSave {
  kind: "limina.save.log";
  version: number;
  tick: number;
  files: ExportFiles;
}

/** In-memory holder of checkpoints + named slots. Lives in the closure of one
 *  registry; a fresh replay registry starts empty and rebuilds via re-invoked skills. */
export class SaveManager {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly slots = new Map<string, SaveSlot>();

  storeCheckpoint(cp: Checkpoint): void {
    this.checkpoints.set(cp.name, cp);
  }
  getCheckpoint(name: string): Checkpoint | undefined {
    return this.checkpoints.get(name);
  }
  listCheckpoints(): { name: string; tick: number; entityCount: number }[] {
    return [...this.checkpoints.values()].map((cp) => ({ name: cp.name, tick: cp.tick, entityCount: cp.world.entities.length }));
  }
  deleteCheckpoint(name: string): boolean {
    return this.checkpoints.delete(name);
  }

  createSlot(name: string, data: string, tick: number, metadata: Record<string, unknown> = {}): SaveSlot {
    const slot: SaveSlot = { name, data, createdTick: tick, gameTick: tick, metadata };
    this.slots.set(name, slot);
    return slot;
  }
  loadSlot(name: string): SaveSlot | undefined {
    return this.slots.get(name);
  }
  deleteSlot(name: string): boolean {
    return this.slots.delete(name);
  }
  listSlots(): { name: string; gameTick: number; metadata: Record<string, unknown> }[] {
    return [...this.slots.values()].map((s) => ({ name: s.name, gameTick: s.gameTick, metadata: s.metadata }));
  }
}

// ── transform restore ────────────────────────────────────────────────────────
// Write a captured entity's ECS transform back into the SoA storage captureWorldState
// reads from — the symmetric inverse of capture. Uses TransformStorage when present
// (so the spatial index's version gate notices), else writes the global SoA directly.
function restoreEntityTransform(ctx: ExecutionContext, e: EntityState): void {
  const eid = e.eid;
  const ts = ctx.world.transforms;
  if (ts !== undefined) {
    ts.writePosition(eid, e.pos[0], e.pos[1], e.pos[2]);
    ts.writeRotation(eid, e.rot[0], e.rot[1], e.rot[2], e.rot[3]);
    ts.writeScale(eid, e.scale[0], e.scale[1], e.scale[2]);
    return;
  }
  Position.x[eid] = e.pos[0]; Position.y[eid] = e.pos[1]; Position.z[eid] = e.pos[2];
  Rotation.x[eid] = e.rot[0]; Rotation.y[eid] = e.rot[1]; Rotation.z[eid] = e.rot[2]; Rotation.w[eid] = e.rot[3];
  Scale.x[eid] = e.scale[0]; Scale.y[eid] = e.scale[1]; Scale.z[eid] = e.scale[2];
}

/** Restore a captured world snapshot into the live world: re-issue the entity-table
 *  identity, then write back every captured transform. Returns the entity count. */
function restoreWorldSnapshot(ctx: ExecutionContext, table: EntityTableSnapshot, world: WorldStateSnapshot): number {
  ctx.world.entities.restore(table);
  for (const e of world.entities) restoreEntityTransform(ctx, e);
  return world.entities.length;
}

/** A DETERMINISTIC world-log meta for the export header: createdAt is derived from the
 *  tick (NOT wall-clock), so two exports at the same tick over the same command stream
 *  are byte-identical (WorldRecorder.meta() uses new Date() — unusable for replay). */
function deterministicMeta(recorder: WorldRecorder, tick: number): WorldLogMeta {
  let maxTick = 0;
  for (const c of recorder.commands) {
    const t = (c as { tick?: number }).tick;
    if (typeof t === "number" && t > maxTick) maxTick = t;
  }
  return {
    kind: "meta",
    logVersion: LOG_VERSION,
    sessionId: recorder.sessionId,
    createdAt: `tick:${tick}`,
    commands: recorder.commands.length,
    ticks: maxTick,
  };
}

export function registerSaveSkills(
  registry: SkillRegistry,
  opts?: {
    saveManager?: SaveManager;
    /** When wired, save.export/import use the LOG FACADE (serialize/replay the durable
     *  command stream). Absent → the real-snapshot fallback (current index.ts default). */
    recorder?: WorldRecorder;
    /** World id stamped into the exported package manifest (log-facade mode). */
    worldId?: string;
    /** Replay factories so save.import can reconstruct a fresh world from the durable
     *  log (loadExport + replayCommands). Absent → import verifies the package and
     *  surfaces its command count; reconstruct via the engine's replayCommands harness. */
    replay?: ReplayDeps;
  },
): { saveManager: SaveManager } {
  const mgr = opts?.saveManager ?? new SaveManager();
  const recorder = opts?.recorder;
  const worldId = opts?.worldId ?? "limina.save";
  const replayDeps = opts?.replay;

  // ---- checkpoint.create ----------------------------------------------------
  const createCheckpointInput = z.object({
    name: z.string().min(1),
    includeGameState: z.boolean().default(true).describe("Whether to store the supplied gameState in the checkpoint."),
    includeEntityPositions: z.boolean().default(true).describe("Whether to capture entity transforms + identity."),
    /** Agent-supplied serializable game state (the game-layer state the caller owns).
     *  Stored verbatim and returned by checkpoint.load for the caller to re-apply. */
    gameState: z.record(z.string(), z.unknown()).optional().describe("Serializable game-layer state to snapshot."),
    meta: MetaField,
  });
  const createCheckpoint: SkillDefinition<z.infer<typeof createCheckpointInput>, { ok: boolean; name: string; entityCount: number }> = {
    name: "checkpoint.create",
    version: "1.0.0",
    description: "Create a named checkpoint of the CURRENT world state: every live entity's ECS transform (Position/Rotation/Scale, + body transform when body-bound), the entity-table identity, and the supplied serializable gameState. Restored by checkpoint.load. Does NOT capture native physics body internals or render meshes.",
    category: "save",
    permissions: ["checkpoint.write"],
    input: createCheckpointInput,
    output: z.object({ ok: z.boolean(), name: z.string(), entityCount: z.number() }),
    handler: (input, ctx) => {
      const world = input.includeEntityPositions ? captureWorldState(ctx.world) : { entities: [] };
      const entityTable = ctx.world.entities.snapshot();
      const cp: Checkpoint = {
        name: input.name,
        tick: ctx.tick,
        gameState: input.includeGameState ? (input.gameState ?? {}) : {},
        world,
        entityTable,
        createdTick: ctx.tick,
      };
      mgr.storeCheckpoint(cp);
      ctx.emit("checkpoint.created", { name: input.name, entityCount: world.entities.length, tick: ctx.tick, ...input.meta });
      return { ok: true, name: input.name, entityCount: world.entities.length };
    },
  };

  // ---- checkpoint.load ------------------------------------------------------
  const loadCheckpointInput = z.object({ name: z.string().min(1), meta: MetaField });
  const loadCheckpoint: SkillDefinition<
    z.infer<typeof loadCheckpointInput>,
    { ok: boolean; checkpoint?: { name: string; tick: number; entityCount: number }; gameState?: Record<string, unknown> }
  > = {
    name: "checkpoint.load",
    version: "1.0.0",
    description: "Restore a named checkpoint: re-issue the entity-table identity, write every captured entity transform back into the world, and return the stored gameState for the caller to re-apply. Native physics bodies, meshes, and closure-bound managers are NOT restored (re-derive those by replaying their authoring skills).",
    category: "save",
    permissions: ["checkpoint.write"],
    input: loadCheckpointInput,
    output: z.object({
      ok: z.boolean(),
      checkpoint: z.object({ name: z.string(), tick: z.number(), entityCount: z.number() }).optional(),
      gameState: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: (input, ctx) => {
      const cp = mgr.getCheckpoint(input.name);
      if (cp === undefined) return { ok: false };
      const restored = restoreWorldSnapshot(ctx, cp.entityTable, cp.world);
      ctx.emit("checkpoint.loaded", { name: input.name, tick: cp.tick, entityCount: restored, ...input.meta });
      return { ok: true, checkpoint: { name: cp.name, tick: cp.tick, entityCount: restored }, gameState: cp.gameState };
    },
  };

  // ---- checkpoint.list ------------------------------------------------------
  const listCheckpointsInput = z.object({ meta: MetaField });
  const listCheckpoints: SkillDefinition<z.infer<typeof listCheckpointsInput>, { checkpoints: { name: string; tick: number; entityCount: number }[] }> = {
    name: "checkpoint.list",
    version: "1.0.0",
    description: "List available checkpoints for the current session (name, tick, captured entity count).",
    category: "save",
    permissions: ["checkpoint.read"],
    input: listCheckpointsInput,
    output: z.object({ checkpoints: z.array(z.object({ name: z.string(), tick: z.number(), entityCount: z.number() })) }),
    handler: () => ({ checkpoints: mgr.listCheckpoints() }),
  };

  // ---- checkpoint.delete ----------------------------------------------------
  const deleteCheckpointInput = z.object({ name: z.string().min(1), meta: MetaField });
  const deleteCheckpoint: SkillDefinition<z.infer<typeof deleteCheckpointInput>, { ok: boolean }> = {
    name: "checkpoint.delete",
    version: "1.0.0",
    description: "Delete a named checkpoint.",
    category: "save",
    permissions: ["checkpoint.write"],
    input: deleteCheckpointInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.deleteCheckpoint(input.name);
      ctx.emit("checkpoint.deleted", { name: input.name, ok, ...input.meta });
      return { ok };
    },
  };

  // ---- save.export ----------------------------------------------------------
  const exportSaveInput = z.object({
    name: z.string().min(1),
    /** Agent-supplied serializable game state to embed (snapshot-fallback mode). */
    gameState: z.record(z.string(), z.unknown()).optional().describe("Serializable game-layer state to embed in the save."),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Custom save-slot metadata (playtime, location, etc.)."),
    meta: MetaField,
  });
  const exportSave: SkillDefinition<z.infer<typeof exportSaveInput>, { ok: boolean; name: string; bytes: number; mode: "log" | "snapshot" }> = {
    name: "save.export",
    version: "1.0.0",
    description: "Export the current world as a save file into a named slot. LOG-FACADE mode (when a recorder is wired): serializes the recorded command stream into a portable export package (the durable world log). SNAPSHOT mode (default): serializes the real world snapshot (entity transforms + identity + gameState). Deterministic — derives its timestamp from the tick, so two exports at the same tick over the same state are byte-identical.",
    category: "save",
    permissions: ["save.write"],
    input: exportSaveInput,
    output: z.object({ ok: z.boolean(), name: z.string(), bytes: z.number(), mode: z.enum(["log", "snapshot"]) }),
    handler: (input, ctx) => {
      let data: string;
      let mode: "log" | "snapshot";
      if (recorder !== undefined) {
        // LOG FACADE: the recorded command stream IS the portable, replayable format.
        const meta = deterministicMeta(recorder, ctx.tick);
        const files = assembleExport({
          worldId,
          meta,
          commands: recorder.commands as WorldCommand[],
          keyframes: [],
          keyframeInterval: 0,
          createdAt: `tick:${ctx.tick}`,
        });
        const payload: LogSave = { kind: "limina.save.log", version: SAVE_VERSION, tick: ctx.tick, files };
        data = JSON.stringify(payload);
        mode = "log";
      } else {
        // SNAPSHOT FALLBACK: serialize the REAL world snapshot (not a fake string).
        const payload: SnapshotSave = {
          kind: "limina.save.snapshot",
          version: SAVE_VERSION,
          tick: ctx.tick,
          gameState: input.gameState ?? {},
          world: captureWorldState(ctx.world),
          entityTable: ctx.world.entities.snapshot(),
        };
        data = JSON.stringify(payload);
        mode = "snapshot";
      }
      mgr.createSlot(input.name, data, ctx.tick, input.metadata);
      ctx.emit("save.exported", { name: input.name, bytes: data.length, mode, tick: ctx.tick, ...input.meta });
      return { ok: true, name: input.name, bytes: data.length, mode };
    },
  };

  // ---- save.import ----------------------------------------------------------
  const importSaveInput = z.object({
    data: z.string().min(1).describe("Serialized save data (a SnapshotSave or LogSave JSON wrapper)."),
    meta: MetaField,
  });
  const importSave: SkillDefinition<
    z.infer<typeof importSaveInput>,
    { ok: boolean; mode?: "log" | "snapshot"; entities?: number; commands?: number; gameState?: Record<string, unknown> }
  > = {
    name: "save.import",
    version: "1.0.0",
    description: "Import a save file and reconstruct world state. SNAPSHOT saves are restored directly into the world (entity identity + transforms + gameState). LOG saves are loadExport-verified (content hashes) and, when replay factories are wired, replayed into a fresh world via the engine's replayCommands harness; otherwise the verified command count is surfaced for the caller to replay.",
    category: "save",
    permissions: ["save.write"],
    input: importSaveInput,
    output: z.object({
      ok: z.boolean(),
      mode: z.enum(["log", "snapshot"]).optional(),
      entities: z.number().optional(),
      commands: z.number().optional(),
      gameState: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (input, ctx) => {
      let parsed: { kind?: string };
      try {
        parsed = JSON.parse(input.data) as { kind?: string };
      } catch {
        return { ok: false };
      }
      if (parsed.kind === "limina.save.snapshot") {
        const snap = parsed as SnapshotSave;
        const entities = restoreWorldSnapshot(ctx, snap.entityTable, snap.world);
        ctx.emit("save.imported", { mode: "snapshot", entities, gameState: snap.gameState, ...input.meta });
        return { ok: true, mode: "snapshot", entities, gameState: snap.gameState };
      }
      if (parsed.kind === "limina.save.log") {
        const log = parsed as LogSave;
        // loadExport re-verifies the package (content hashes + manifest cross-checks).
        const loaded = loadExport(log.files, ctx.world.ops);
        if (replayDeps !== undefined) {
          const res = await replayCommands(loaded.commands, replayDeps);
          ctx.emit("save.imported", { mode: "log", commands: loaded.commands.length, entities: res.state.entities.length, ...input.meta });
          return { ok: true, mode: "log", commands: loaded.commands.length, entities: res.state.entities.length };
        }
        ctx.emit("save.imported", { mode: "log", commands: loaded.commands.length, ...input.meta });
        return { ok: true, mode: "log", commands: loaded.commands.length };
      }
      return { ok: false };
    },
  };

  // ---- save.slot ------------------------------------------------------------
  const slotInput = z.object({
    action: z.enum(["create", "load", "delete", "list"]).default("list"),
    name: z.string().min(1).optional(),
    data: z.string().optional().describe("Serialized save data (for the create action)."),
    metadata: z.record(z.string(), z.unknown()).optional(),
    meta: MetaField,
  });
  const saveSlot: SkillDefinition<
    z.infer<typeof slotInput>,
    { ok: boolean; slots?: { name: string; gameTick: number; metadata: Record<string, unknown> }[]; data?: string }
  > = {
    name: "save.slot",
    version: "1.0.0",
    description: "Manage named save slots (persistent across sessions): create/load/delete/list slots holding the real serialized save data produced by save.export.",
    category: "save",
    permissions: ["save.write"],
    input: slotInput,
    output: z.object({
      ok: z.boolean(),
      slots: z.array(z.object({ name: z.string(), gameTick: z.number(), metadata: z.record(z.string(), z.unknown()) })).optional(),
      data: z.string().optional(),
    }),
    handler: (input, ctx) => {
      switch (input.action) {
        case "create": {
          if (input.name === undefined || input.data === undefined) return { ok: false };
          mgr.createSlot(input.name, input.data, ctx.tick, input.metadata);
          ctx.emit("save.slot.created", { name: input.name, bytes: input.data.length, ...input.meta });
          return { ok: true };
        }
        case "load": {
          if (input.name === undefined) return { ok: false };
          const slot = mgr.loadSlot(input.name);
          return { ok: slot !== undefined, data: slot?.data };
        }
        case "delete": {
          if (input.name === undefined) return { ok: false };
          const ok = mgr.deleteSlot(input.name);
          ctx.emit("save.slot.deleted", { name: input.name, ok, ...input.meta });
          return { ok };
        }
        default:
          return { ok: true, slots: mgr.listSlots() };
      }
    },
  };

  registry.register(createCheckpoint);
  registry.register(loadCheckpoint);
  registry.register(listCheckpoints);
  registry.register(deleteCheckpoint);
  registry.register(exportSave);
  registry.register(importSave);
  registry.register(saveSlot);

  return { saveManager: mgr };
}
