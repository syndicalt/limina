// Permission profiles (static allow-lists) resolved to a Set for O(1) checks.
// Data-only agents in MVP; true capability isolation (QuickJS) is Phase 2.

export const PERMISSION_PROFILES: Record<string, readonly string[]> = {
  "builder.readWrite": [
    "scene.read", "scene.write", "ecs.read", "ecs.modify",
    "physics.read", "physics.write", "agent.read", "agent.write",
    "ui.write", "audio.play",
  ],
  "player.limited": [
    "scene.read", "ecs.read", "physics.read", "physics.write", "agent.read", "agent.write",
  ],
  // Conversational agents: perceive the world + act SOCIALLY (approach/say). The
  // `social.act` capability gates the social.* skills; it is deliberately ABSENT
  // from player.limited so a non-social agent is denied with zero effect.
  "social.actor": [
    "scene.read", "ecs.read", "physics.read", "agent.read", "agent.write", "social.act", "audio.play",
  ],
  "system.readonly": ["scene.read", "ecs.read", "physics.read", "agent.read"],
};

export function resolveProfile(name: string): ReadonlySet<string> {
  return new Set(PERMISSION_PROFILES[name] ?? []);
}
