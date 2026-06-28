// Permission profiles (static allow-lists) resolved to a Set for O(1) checks.
// Data-only agents in MVP; true capability isolation (QuickJS) is Phase 2.

export const PERMISSION_PROFILES: Record<string, readonly string[]> = {
  "builder.readWrite": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "agent.read", "agent.write",
    "ui.write", "audio.play", "terrain.read", "terrain.generate",
    "player.read", "player.write", "player.configure",
    "camera.write", "animation.read", "animation.write",
    "interaction.read", "interaction.write", "interaction.configure",
    "inventory.read", "inventory.write", "inventory.configure",
    "item.configure",
    "game.write", "game.configure",
    "trigger.configure", "event.read", "event.write",
    "quest.read", "quest.write", "quest.configure",
    "stats.read", "stats.write", "stats.configure",
    "damage.write", "status.read", "status.write",
    "combat.write",
    "behavior.read", "behavior.write", "behavior.configure",
    "dialogue.read", "dialogue.write", "dialogue.configure",
    "nav.read", "nav.write", "nav.configure",
    "vfx.write",
    "checkpoint.read", "checkpoint.write",
    "save.write",
    "progression.read", "progression.write", "progression.configure",
    "world.read", "world.write",
  ],
  // Full player character control (Part D).
  "player.full": [
    "scene.read", "ecs.read", "physics.read", "physics.write", "agent.read",
    "terrain.read",
    "player.read", "player.write", "player.configure",
    "camera.write",
    "animation.read",
    "interaction.read", "interaction.write",
    "inventory.read",
    "dialogue.read",
  ],
  "player.limited": [
    "scene.read", "ecs.read", "physics.read", "physics.write", "agent.read", "agent.write",
    "terrain.read",
    "player.read", "player.write",
    "camera.write",
    "interaction.read", "interaction.write",
    "inventory.read", "inventory.write",
    "game.write",
    "quest.read",
    "stats.read",
    "status.read",
    "behavior.read",
    "dialogue.read", "dialogue.write",
    "nav.read", "nav.write",
    "checkpoint.read", "checkpoint.write",
    "progression.read",
    "world.read",
  ],
  // NPC behavior agent: perception, behavior, dialogue, navigation, combat
  "npc.agent": [
    "scene.read", "ecs.read", "physics.read", "agent.read", "agent.write",
    "social.act", "audio.play",
    "behavior.read", "behavior.write",
    "dialogue.read", "dialogue.write", "dialogue.configure",
    "nav.read", "nav.write",
    "stats.read", "stats.write", "stats.configure",
    "damage.write", "status.read", "status.write",
    "combat.write",
    "animation.read", "animation.write",
    "inventory.read",
    "interaction.read",
  ],
  // Game rules and quest authoring
  "game.author": [
    "game.write", "game.configure",
    "quest.read", "quest.write", "quest.configure",
    "trigger.configure", "event.read", "event.write",
    "stats.configure",
    "scene.read", "ecs.read", "physics.read", "agent.read",
  ],
  // Combat and damage systems
  "combat.writer": [
    "combat.write", "damage.write", "status.read", "status.write",
    "stats.read", "stats.write",
    "scene.read", "ecs.read", "physics.read",
  ],
  // Visual effects authoring
  "vfx.writer": [
    "vfx.write", "animation.write",
    "scene.read", "ecs.read",
  ],
  // World dynamics (time, weather, spawn)
  "world.author": [
    "world.write", "checkpoint.read", "checkpoint.write",
    "save.write",
    "scene.read", "ecs.read", "physics.read",
  ],
  // Terrain authoring (existing)
  "terrain.author": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "terrain.read", "terrain.generate",
  ],
  // Conversational agents (existing)
  "social.actor": [
    "scene.read", "ecs.read", "physics.read", "agent.read", "agent.write", "social.act", "audio.play",
  ],
  // Observer profiles (existing)
  "system.readonly": ["scene.read", "ecs.read", "physics.read", "agent.read", "trace.read"],
  // Phase 7 human-in-the-loop (existing)
  "builder.review": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "agent.read", "agent.write",
    "ui.write", "audio.play",
  ],
  "reviewer": ["scene.read", "ecs.read", "physics.read", "agent.read", "approval.review", "trace.read"],
  // Phase 10 coordinator/delegate (existing)
  "reviewer.coordinator": [
    "orchestrate", "approval.review",
    "scene.read", "ecs.read", "physics.read", "agent.read", "trace.read",
  ],
};

export function resolveProfile(name: string): ReadonlySet<string> {
  return new Set(PERMISSION_PROFILES[name] ?? []);
}
