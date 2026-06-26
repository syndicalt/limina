// Registers the core MVP skill set on a registry.

import type { SkillRegistry } from "./registry.ts";
import type { LiminaTracer } from "../observability/event.ts";
import { registerSceneSkills } from "./scene.ts";
import { registerEcsSkills } from "./ecs.ts";
import { registerThreeSkills } from "./three.ts";
import { registerPhysicsSkills } from "./physics.ts";
import { registerAgentSkills } from "./agent.ts";
import { registerSystemSkills } from "./system.ts";
import { registerApprovalSkills } from "./approval.ts";
import { registerAuditSkills } from "../policy/audit.ts";
import { registerUiSkills } from "./ui.ts";
import { SandboxedSkillHost } from "../sandbox/host.ts";
import { PackageRegistry, registerPackageSkills } from "../packages/index.ts";
import { UiManager } from "../ui/manager.ts";
import { Locomotion } from "../world/locomotion.ts";
import { registerSocialSkills, type SocialRuntime } from "./social.ts";
import { AudioManager } from "../audio/manager.ts";
import { registerAudioSkills } from "./audio.ts";
import { registerTerrainSkills } from "./terrain.ts";
import { ProceduralTerrainSource } from "../terrain/procedural.ts";
import { TileCache } from "../terrain/tilecache.ts";
import type { TerrainSource } from "../terrain/types.ts";

/** Stateful helpers the core skill set builds and shares with its skills, handed
 *  back so a host/demo can drive them (the UiManager's per-frame tick, the M9
 *  package registry). */
export interface CoreSkills {
  packages: PackageRegistry;
  ui: UiManager;
  audio: AudioManager;
  /** Walk-to-target system shared with the social skills (and the host's tick). */
  locomotion: Locomotion;
  /** Inspection surface for the per-speaker speech bubbles social.say authors. */
  social: SocialRuntime;
  /** Phase 9 terrain source + content-addressed tile cache backing the terrain.*
   *  / world.* skills (default: the deterministic procedural source). */
  terrain: { source: TerrainSource; cache: TileCache };
}

export function registerCoreSkills(registry: SkillRegistry, opts?: { terrainSource?: TerrainSource; terrainCache?: TileCache }): CoreSkills {
  registerSceneSkills(registry);
  registerEcsSkills(registry);
  registerThreeSkills(registry);
  registerPhysicsSkills(registry);
  registerAgentSkills(registry);
  registerSystemSkills(registry);
  registerApprovalSkills(registry);
  registerAuditSkills(registry);
  // A4 UI surface: the `ui.*` skills author live containers against a shared
  // UiManager; the host ticks UiManager.update(camera,…) each frame.
  const ui = new UiManager();
  registerUiSkills(registry, ui);
  // Audio surface: the `audio.*` skills play synthesized SFX/ambience/positional
  // sound via the native limina-audio backend (op_audio_*). The host calls
  // op_audio_init() once and drives the per-frame listener sync (AudioManager).
  const audio = new AudioManager();
  registerAudioSkills(registry, audio);
  // Embodied social surface: a shared walk-to-target Locomotion (also the
  // host-bound speaker -> entity resolver) + the social.* skills, which set move
  // targets (social.approach) and drive REAL speech bubbles anchored to the
  // SPEAKING agent's humanoid (social.say). A payload-supplied id can never
  // spoof a speaker — attribution is bound to ctx.agentId via the resolver.
  const locomotion = new Locomotion();
  const social = registerSocialSkills(registry, {
    ui,
    locomotion,
    resolveEntity: (agentId) => locomotion.entityIdOf(agentId),
  });
  // M9 packaging: a default versioned package registry over a sandbox host that
  // shares this registry + tracer, so `package.*` skills exist out of the box.
  // A runtime/test wanting a policy-attached package registry constructs its own
  // and calls registerPackageSkills again to rebind these skills to it.
  const host = new SandboxedSkillHost(registry, registry.tracer);
  const packages = new PackageRegistry(registry, host, registry.tracer as LiminaTracer);
  registerPackageSkills(registry, packages);
  // Phase 9 terrain seam: the terrain.* / world.* skills over a deterministic
  // procedural source + a content-addressed tile cache. A runtime can override
  // the source (model at authoring, cache at replay) via opts; the cache is the
  // snapshot/export-carried tile store.
  const terrainSource: TerrainSource = opts?.terrainSource ?? new ProceduralTerrainSource();
  const terrainCache = opts?.terrainCache ?? new TileCache();
  registerTerrainSkills(registry, terrainSource, terrainCache);
  return { packages, ui, locomotion, social, audio, terrain: { source: terrainSource, cache: terrainCache } };
}
