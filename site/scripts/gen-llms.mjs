// Generates public/llms.txt (curated index) and public/llms-full.txt (every doc
// page as one plain-text file) from the Starlight docs. Runs in `prebuild`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docsDir = path.join(root, 'src/content/docs');
const ORIGIN = (process.env.SITE_URL || process.env.SITE || 'https://www.liminaengine.com').replace(/\/$/, '');
const BASE = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
const SITE = ORIGIN + BASE;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md') || e.name.endsWith('.mdx')) out.push(p);
  }
  return out;
}

function parse(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  const data = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (mm) data[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
    }
  }
  const body = m ? src.slice(m[0].length) : src;
  const slug = path.relative(docsDir, file).replace(/\.(md|mdx)$/, '');
  return { slug, title: data.title || slug, description: data.description || '', body: body.trim() };
}

const ORDER = [
  'introduction', 'getting-started', 'demos', 'architecture',
  'concepts/ecs-and-world', 'concepts/loop', 'concepts/perception', 'concepts/observability',
  'pillars/skill-registry', 'pillars/mcp-interface', 'pillars/observability', 'pillars/agent-ecosystem',
  'skills', 'building-agents/builders', 'building-agents/players', 'building-agents/llm-providers', 'roadmap',
];
const rank = (s) => { const i = ORDER.indexOf(s); return i === -1 ? ORDER.length + 1 : i; };

const docs = walk(docsDir).map(parse).sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));

const intro = `Limina is an agent-native real-time 3D engine: a single native binary (Rust host + V8 via deno_core + WebGPU via deno_webgpu + Three.js + native Rapier physics + bitECS) where LLM agents are first-class. External builders construct scenes over MCP; autonomous players perceive, decide, and act in-world. Every action is typed, permission-checked, and traced.`;

let llms = `# Limina\n\n> ${intro}\n\n`;
llms += `Key facts for agents:\n`;
llms += `- The engine is the substrate, not the brain: it owns the world, perception, the skill/MCP surface, and a durable event log. Decision-making and memory are pluggable and external.\n`;
llms += `- Agents act only through ${'45'} typed, versioned, permission-checked skills, exposed as MCP tools over in-process, stdio (\`--mcp-stdio\`), or websocket (\`--mcp-ws\`) transports.\n`;
llms += `- Every action emits a typed, sha256-chained event into a durable, replayable world log.\n\n`;
llms += `## Documentation\n\n`;
for (const d of docs) llms += `- [${d.title}](${SITE}/${d.slug}): ${d.description}\n`;
llms += `\n## For agents\n\n`;
llms += `- [skills.json](${SITE}/agents/skills.json): machine-readable catalog of all skills (names, permissions, JSON-Schema inputs)\n`;
llms += `- [llms-full.txt](${SITE}/llms-full.txt): the full documentation as a single plain-text file\n`;
llms += `- [Agents hub](${SITE}/agents): machine endpoints and the MCP connect quickstart\n`;

fs.writeFileSync(path.join(root, 'public/llms.txt'), llms);

let full = `# Limina — full documentation\n\n> ${intro}\n\nSource: ${SITE}\nThis file concatenates every documentation page as plain text.\n\n`;
for (const d of docs) {
  full += `\n\n${'='.repeat(72)}\n# ${d.title}\nURL: ${SITE}/${d.slug}\n${d.description ? '\n' + d.description + '\n' : ''}\n${d.body}\n`;
}
fs.writeFileSync(path.join(root, 'public/llms-full.txt'), full);

console.log(`wrote public/llms.txt (${llms.length} bytes) and public/llms-full.txt (${full.length} bytes) from ${docs.length} docs`);
