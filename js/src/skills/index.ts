// Registers the core MVP skill set on a registry.

import type { SkillRegistry } from "./registry.ts";
import type { LiminaTracer } from "../observability/event.ts";
import { registerSceneSkills } from "./scene.ts";
import { registerEcsSkills } from "./ecs.ts";
import { registerThreeSkills } from "./three.ts";
import { registerAssetSkills } from "./asset.ts";
import { registerMaterialSkills } from "./material.ts";
import { AssetRegistry } from "../asset-registry.ts";
import { MaterialRegistry } from "../materials/material-registry.ts";
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
import { registerTerrainSkills, type RegionState } from "./terrain.ts";
import { registerRenderSkills } from "./render.ts";
import { registerWaterSkills, type WaterSurfaceState } from "./water.ts";
import { ProceduralTerrainSource } from "../terrain/procedural.ts";
import { TileCache } from "../terrain/tilecache.ts";
import type { TerrainSource } from "../terrain/types.ts";
import { registerOrchestrationSkills } from "./orchestration.ts";
import type { ProviderMap } from "../agents/systems.ts";
import type { AgentRegistry } from "../agents/agent.ts";
import { registerPlayerSkills, type InputRegistry, type CharacterControllerRegistry } from "./player.ts";
import { registerCameraSkills, type CameraManager } from "./camera.ts";
import { registerAnimationSkills, type AnimationManager } from "./animation.ts";
import { registerInteractionSkills, type InteractionManager } from "./interaction.ts";
import { registerInventorySkills, type InventoryManager } from "./inventory.ts";
import { registerGameStateSkills, type GameStateManager } from "./gamestate.ts";
import { registerTriggerEventSkills, type TriggerManager, type EventManager } from "./triggers.ts";
import { registerCutsceneSkills, type CutsceneManager } from "./cutscene.ts";
import { registerArchitectureSkills } from "./architecture.ts";
import { registerDirectorSkills, type DirectorManager } from "./director.ts";
import { registerAbilitySkills, type AbilityManager } from "./ability.ts";
import { registerClipAuthorSkills, type ClipAuthor } from "./clip_author.ts";
import { registerQuestSkills, type QuestManager } from "./quest.ts";
import { registerCombatSkills, type StatsManager, type CombatManager } from "./combat.ts";
import { registerBehaviorDialogueSkills, type BehaviorManager, type DialogueManager } from "./behavior.ts";
import { registerNavmeshSkills, type NavmeshManager } from "./navmesh.ts";
import { registerVFXSkills, type VFXManager } from "./vfx.ts";
import { registerSaveSkills, type SaveManager } from "./save.ts";
import { registerProgressionSkills, type ProgressionManager } from "./progression.ts";
import { registerWorldAudioExtensionSkills, type WorldStateManager, type BGMManager, type ReverbManager } from "./worldstate.ts";

/** Stateful helpers the core skill set builds and shares with its skills, handed
 *  back so a host/demo can drive them (the UiManager's per-frame tick, the M9
 *  package registry). */
export interface CoreSkills {
  packages: PackageRegistry;
  ui: UiManager;
  audio: AudioManager;
  locomotion: Locomotion;
  social: SocialRuntime;
  terrain: { source: TerrainSource; cache: TileCache; regions: Map<string, RegionState> };
  assets: AssetRegistry;
  materials: MaterialRegistry;
  water: { surfaces: WaterSurfaceState[] };
  /** Phase 12: player input and movement surface. */
  player: { input: InputRegistry; controllers: CharacterControllerRegistry };
  /** Phase 12: camera rigs and control. */
  camera: { cameraManager: CameraManager };
  /** Phase 12: animation system. */
  animation: { animationManager: AnimationManager };
  /** Phase 12: interaction system. */
  interaction: { interactionManager: InteractionManager };
  /** Phase 12: inventory and items. */
  inventory: { inventoryManager: InventoryManager };
  /** Phase 12: game state and rules. */
  gamestate: { gameStateManager: GameStateManager };
  /** Phase 12: triggers and events. */
  triggers: { triggerManager: TriggerManager; eventManager: EventManager };
  /** Track C: scripted timeline / cutscene sequencer. */
  cutscene: { cutsceneManager: CutsceneManager };
  /** Track C: AI director (deterministic pacing / orchestration). */
  director: { directorManager: DirectorManager };
  /** Track C: procedural animation authoring (keyframe clips + sampling). */
  clips: { clipAuthor: ClipAuthor };
  /** Phase 12: quests and objectives. */
  quest: { questManager: QuestManager };
  /** Phase 12: stats, damage, status, combat. */
  combat: { statsManager: StatsManager; combatManager: CombatManager };
  /** Track C: ability system (cooldowns + resource costs) — combat depth. */
  ability: { abilityManager: AbilityManager };
  /** Phase 12: NPC behavior and dialogue. */
  behavior: { behaviorManager: BehaviorManager; dialogueManager: DialogueManager };
  /** Phase 12: navigation and pathfinding. */
  nav: { navmeshManager: NavmeshManager };
  /** Phase 12: visual effects and particles. */
  vfx: { vfxManager: VFXManager };
  /** Phase 12: save, load, checkpoints. */
  save: { saveManager: SaveManager };
  /** Phase 12: progression, XP, skill trees. */
  progression: { progressionManager: ProgressionManager };
  /** Phase 12: world dynamics (time, weather, spawn) and audio extensions (BGM, SFX, reverb). */
  worldstate: { worldStateManager: WorldStateManager; bgmManager: BGMManager; reverbManager: ReverbManager };
}

export function registerCoreSkills(
  registry: SkillRegistry,
  opts?: {
    terrainSource?: TerrainSource;
    terrainCache?: TileCache;
    /** Phase 10 coordinator/delegate: when a provider map is supplied, the
     *  `delegate` skill is wired so a coordinator can spawn least-privilege
     *  workers under review. Omitted -> no orchestration surface (back-compat). */
    providers?: ProviderMap;
    /** Where delegated workers are registered (optional; a self-contained
     *  registry is used when omitted). */
    agents?: AgentRegistry;
    /** Phase 11: override the content-addressed asset registry (e.g. a pre-pinned
     *  curated registry). Default: a fresh registry over the host ops. */
    assets?: AssetRegistry;
  },
): CoreSkills {
  // Phase 11 content-addressed asset seam: BOTH three.loadGLTF and asset.place
  // resolve a GLTF by id through this one registry (id -> bytes + cached content
  // hash). A runtime can inject a package-backed registry (AssetRegistry.fromBundle)
  // so a replayed/browser asset.place loads from the export, never the host root.
  const assets = opts?.assets ?? new AssetRegistry();
  // Phase 9 terrain source + content-addressed tile cache. Constructed up front so
  // asset.scatter (registered below) shares the SAME deterministic source + cache the
  // terrain.* / world.* skills use — a scattered region matches the generated world,
  // and a replay re-resolves identical tiles. The terrain.* skills bind to them below.
  const terrainSource: TerrainSource = opts?.terrainSource ?? new ProceduralTerrainSource();
  const terrainCache = opts?.terrainCache ?? new TileCache();
  // The region table is shared by the terrain.* skills (which populate it in
  // world.generateRegion) and asset.scatter (which binds a scatter to a region by id,
  // reading its seed/lod + applied tiles — no free-floating scatter seed).
  const terrainRegions = new Map<string, RegionState>();
  // Phase 2b imported-material registry: the named, built texture-pack materials that
  // scene.createEntity / three.setMaterial resolve by name. material.import populates it
  // (resolving + decoding images through the SAME content-addressed asset registry, so the
  // bytes ride the export); a replay re-runs the recorded import requests to rebuild it.
  const materials = new MaterialRegistry();
  registerSceneSkills(registry, materials);
  registerArchitectureSkills(registry);
  registerEcsSkills(registry);
  registerThreeSkills(registry, assets, materials);
  registerAssetSkills(registry, assets, { source: terrainSource, cache: terrainCache, regions: terrainRegions });
  registerMaterialSkills(registry, assets, materials);
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
  // Phase 9 terrain seam: the terrain.* / world.* skills over the deterministic
  // procedural source + content-addressed tile cache constructed above (also shared
  // with asset.scatter, along with the region table). A runtime can override the
  // source (model at authoring, cache at replay) via opts; the cache is the
  // snapshot/export-carried tile store.
  registerTerrainSkills(registry, terrainSource, terrainCache, terrainRegions);
  // Opt-in, render-only post-processing seam: `render.enablePost` builds the GTAO/bloom/
  // grade pipeline on the live renderer and stows it on world.post (static/cinematic — see
  // render.ts). Render-only; never sim/log state.
  registerRenderSkills(registry);
  // Render-only water seam: `world.addWater` adds a cosmetic sea-level surface so
  // beaches/lakes/oceans read as water. It touches neither physics nor the ECS, so
  // it can never change the deterministic sim/replay — the surface is recomputed
  // from the logged level (like prop scatter).
  // Bound to the SAME deterministic terrain source + the live region table so true
  // depth-aware water is the DEFAULT: an explicit `region` request bakes the depth field
  // from the field the terrain was generated with, and absent one the depth is auto-derived
  // from the regions already generated in this world (the camera-distance proxy is used only
  // when there is no terrain at all). Read-only — never sim/ECS/log state.
  const water = registerWaterSkills(registry, terrainSource, terrainRegions);
  // Phase 10 chunk C: the coordinator/delegate surface. Only wired when a provider
  // map is supplied (the worker loop needs real providers); without it the engine
  // behaves exactly as before — no `delegate` skill registered.
  if (opts?.providers !== undefined) {
    registerOrchestrationSkills(registry, { providers: opts.providers, agents: opts.agents });
  }
  // Phase 12: playable game skills — player, camera, animation, interaction,
  // inventory, game state, triggers/events, quests, combat/stats, behavior/dialogue,
  // navigation, VFX, save/load, progression, world state, and audio extensions.
  const player = registerPlayerSkills(registry);
  const camera = registerCameraSkills(registry);
  const animation = registerAnimationSkills(registry);
  const inventory = registerInventorySkills(registry);
  // interaction.pickup/drop reach into the inventory manager, so it must be created
  // first and passed in (closure-bound cross-dep, like social ← ui/locomotion).
  const interaction = registerInteractionSkills(registry, { inventoryManager: inventory.inventoryManager });
  const gamestate = registerGameStateSkills(registry);
  const triggers = registerTriggerEventSkills(registry);
  const cutscene = registerCutsceneSkills(registry);
  const director = registerDirectorSkills(registry);
  const clips = registerClipAuthorSkills(registry);
  const quest = registerQuestSkills(registry);
  const combat = registerCombatSkills(registry);
  // ability.cast spends from a resource stat, so it binds the combat stats manager (closure dep).
  const ability = registerAbilitySkills(registry, { statsManager: combat.statsManager });
  const behavior = registerBehaviorDialogueSkills(registry);
  const nav = registerNavmeshSkills(registry);
  const vfx = registerVFXSkills(registry);
  const save = registerSaveSkills(registry);
  const progression = registerProgressionSkills(registry);
  const worldstate = registerWorldAudioExtensionSkills(registry);
  return {
    packages, ui, locomotion, social, audio,
    terrain: { source: terrainSource, cache: terrainCache, regions: terrainRegions },
    assets, materials, water,
    player, camera, animation, interaction, inventory,
    gamestate, triggers, cutscene, director, clips, quest, combat, ability, behavior,
    nav, vfx, save, progression, worldstate,
  };
}
