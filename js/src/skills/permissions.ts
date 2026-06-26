// Permission profiles (static allow-lists) resolved to a Set for O(1) checks.
// Data-only agents in MVP; true capability isolation (QuickJS) is Phase 2.

export const PERMISSION_PROFILES: Record<string, readonly string[]> = {
  "builder.readWrite": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "agent.read", "agent.write",
    "ui.write", "audio.play", "terrain.read", "terrain.generate",
  ],
  "player.limited": [
    "scene.read", "ecs.read", "physics.read", "physics.write", "agent.read", "agent.write",
    "terrain.read",
  ],
  // Phase 9 terrain authoring: perceive + query terrain and run the HIGH-COST
  // `world.generateRegion` / `world.streamFollow` generators (gated by
  // `terrain.generate`), plus the physics needed to drop/roll an agent on it.
  "terrain.author": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "terrain.read", "terrain.generate",
  ],
  // Conversational agents: perceive the world + act SOCIALLY (approach/say). The
  // `social.act` capability gates the social.* skills; it is deliberately ABSENT
  // from player.limited so a non-social agent is denied with zero effect.
  "social.actor": [
    "scene.read", "ecs.read", "physics.read", "agent.read", "agent.write", "social.act", "audio.play",
  ],
  "system.readonly": ["scene.read", "ecs.read", "physics.read", "agent.read"],
  // Phase 7 human-in-the-loop. `builder.review` is a builder whose MUTATING edits
  // are held by the review gate (same capabilities as builder.readWrite — it can
  // PROPOSE; the gate decides when its world-writes apply). `reviewer` is the human
  // granter: read the world + resolve held actions via the approval.* skills.
  "builder.review": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "agent.read", "agent.write",
    "ui.write", "audio.play",
  ],
  "reviewer": ["scene.read", "ecs.read", "physics.read", "agent.read", "approval.review"],
};

export function resolveProfile(name: string): ReadonlySet<string> {
  return new Set(PERMISSION_PROFILES[name] ?? []);
}
