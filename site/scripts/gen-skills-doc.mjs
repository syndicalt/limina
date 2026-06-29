// Generates src/content/docs/skills.md from src/data/skills.json so the human
// SDK reference and the machine-readable catalog can never drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/skills.json'), 'utf8'));

// Each group claims a set of name prefixes (the segment before the first dot); a
// skill lands in the first group whose prefixes include its prefix. The set below
// covers every prefix the registry emits, so the "Other" bucket stays empty.
const prefixOf = (n) => n.split('.')[0];
const group = (prefixes) => (n) => prefixes.includes(prefixOf(n));
const GROUPS = [
  { id: 'world', title: 'Scene, terrain & world', blurb: 'Create entities, place and scatter assets, author materials, generate terrain, and drive world dynamics (time, weather, water).', match: group(['scene', 'asset', 'material', 'render', 'terrain', 'world']) },
  { id: 'ecs', title: 'ECS components', blurb: 'Read and mutate component data on entities.', match: group(['ecs']) },
  { id: 'three', title: 'Rendering · Three.js', blurb: 'Transforms, PBR materials, lighting, glTF, and visual effects.', match: group(['three', 'vfx']) },
  { id: 'physics', title: 'Physics · Rapier', blurb: 'Impulses, raycasts, and collision events from native Rapier.', match: group(['physics']) },
  { id: 'player', title: 'Player & camera', blurb: 'Player input and movement, character controllers, and camera rigs.', match: group(['player', 'input', 'camera']) },
  { id: 'animation', title: 'Animation', blurb: 'Load, play, blend, and drive skeletal animation and emotes.', match: group(['animation']) },
  { id: 'interaction', title: 'Interaction & inventory', blurb: 'Interactables, pickups, items, and inventory.', match: group(['interaction', 'inventory', 'item']) },
  { id: 'combat', title: 'Combat, stats & status', blurb: 'Stats, damage, status effects, and combat.', match: group(['combat', 'damage', 'stats', 'status']) },
  { id: 'npc', title: 'NPC behavior & dialogue', blurb: 'Behavior trees, dialogue, and navigation/pathfinding for NPCs.', match: group(['behavior', 'dialogue', 'npc', 'navmesh']) },
  { id: 'game', title: 'Game systems', blurb: 'Game state and rules, quests, triggers and events, and progression.', match: group(['game', 'quest', 'trigger', 'event', 'progression']) },
  { id: 'save', title: 'Save & checkpoints', blurb: 'Save, load, and checkpoint world state.', match: group(['save', 'checkpoint']) },
  { id: 'ui', title: 'In-world UI, audio & social', blurb: 'Speech bubbles, labels, HUD panels, spatial audio and TTS, and embodied social acts.', match: group(['ui', 'audio', 'social']) },
  { id: 'agent', title: 'Agent / meta', blurb: 'Perception and custom event signals for agents.', match: group(['agent']) },
  { id: 'system', title: 'System, packages & audit', blurb: 'Discover skills, tail the trace, snapshot the world, hot-reload, review approvals, audit policy, and load capability packages.', match: group(['skills', 'trace', 'inspector', 'dev', 'audit', 'package', 'approval']) },
];

const esc = (s) => String(s).replace(/\|/g, '\\|');
const keys = (o) => (o && Object.keys(o).length ? Object.keys(o).map((k) => `\`${k}\``).join(', ') : '—');
const perms = (p) => (p && p.length ? p.map((x) => `\`${x}\``).join(' ') : '_none_');

let md = `---
title: "Skills reference"
description: "Every built-in Limina skill — the agent-facing SDK surface — grouped by domain."
---

Limina ships **${data.count} typed skills**: the complete set of actions an agent can take in the world. Each skill is **versioned**, declares the **permissions** it needs, and validates its input against a [Zod](https://zod.dev) schema. Every skill maps **1:1 to an MCP tool** whose name is the skill name — so this page is also the MCP tool list.

:::tip[For agents]
The same catalog is available as machine-readable JSON at [\`/agents/skills.json\`](/agents/skills.json) (names, permissions, and JSON-Schema inputs). See [the MCP interface](/pillars/mcp-interface) for the wire contract and [the registry](/pillars/skill-registry) for the skill model.
:::

## Permission profiles

A session is opened under a profile; the engine enforces the profile's allow-list before any handler runs. A skill with no declared permission is callable under any profile.

| Profile | Grants |
|---------|--------|
`;
for (const [name, list] of Object.entries(data.permissionProfiles)) {
  md += `| \`${name}\` | ${list.map((x) => `\`${x}\``).join(' ')} |\n`;
}
md += `\nAll permission strings: ${data.permissions.map((p) => `\`${p}\``).join(', ')}.\n`;

const used = new Set();
for (const g of GROUPS) {
  const skills = data.skills.filter((s) => g.match(s.name));
  skills.forEach((s) => used.add(s.name));
  if (!skills.length) continue;
  md += `\n## ${g.title}\n\n${g.blurb}\n\n`;
  md += `| Skill | Description | Permissions | Input | Output |\n|---|---|---|---|---|\n`;
  for (const s of skills) {
    md += `| \`${s.name}\` | ${esc(s.description)} | ${perms(s.permissions)} | ${keys(s.input)} | ${keys(s.output)} |\n`;
  }
}

const leftover = data.skills.filter((s) => !used.has(s.name));
if (leftover.length) {
  md += `\n## Other\n\n| Skill | Description | Permissions |\n|---|---|---|\n`;
  for (const s of leftover) md += `| \`${s.name}\` | ${esc(s.description)} | ${perms(s.permissions)} |\n`;
}

md += `\n---\n\nInput field types, defaults, and full JSON Schema for every skill live in [\`/agents/skills.json\`](/agents/skills.json). To call these over the wire, see [Agent Builders](/building-agents/builders).\n`;

const outPath = path.join(root, 'src/content/docs/skills.md');
fs.writeFileSync(outPath, md);
console.log(`wrote ${outPath} (${data.skills.length} skills, ${md.length} bytes)`);
