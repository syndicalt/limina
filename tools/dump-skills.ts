// SKILLS CATALOG DUMP — enumerates the REAL built-in skill registry (the same
// registerCoreSkills the engine boots) and emits the canonical machine-readable
// catalog as JSON between markers on stdout. The node writer (tools/dump-skills.mjs)
// captures it and writes site/src/data/skills.json + site/public/agents/skills.json
// so the marketing site's skills.json endpoint can never drift from the engine.
//
// RUN (regenerate skills.json on disk):
//   node tools/dump-skills.mjs
// which spawns:  ./target/release/limina tools/dump-skills.ts
//
// Headless: builds the registry only (no createEngine, no GPU, no window). Each skill
// maps 1:1 to an MCP tool; input_schema is the Zod-derived JSON Schema (draft-07).

import { z } from "../js/build/zod.bundle.mjs";
import { LiminaTracer } from "../js/src/observability/event.ts";
import { SkillRegistry } from "../js/src/skills/registry.ts";
import { registerCoreSkills } from "../js/src/skills/index.ts";
import { PERMISSION_PROFILES } from "../js/src/skills/permissions.ts";

// ── Compact, human-readable type descriptor for a JSON-Schema property ──────────
// The full JSON Schema rides in each skill's `input_schema`; these short strings are
// the at-a-glance field summaries the docs table renders (keys = field names).
function short(node: unknown): string {
  if (node === undefined || node === null || typeof node !== "object") return "any";
  const s = node as Record<string, unknown>;
  let base: string;
  if (Array.isArray(s.enum)) {
    base = `enum(${(s.enum as unknown[]).map(String).join("|")})`;
  } else if (s.const !== undefined) {
    base = `const(${String(s.const)})`;
  } else if (s.type === "array") {
    if (Array.isArray(s.items)) {
      base = `[${(s.items as unknown[]).map(short).join(",")}]`;
    } else {
      base = `${short(s.items)}[]`;
    }
  } else if (s.type === "object") {
    const props = s.properties as Record<string, unknown> | undefined;
    base = props ? `{${Object.keys(props).join(",")}}` : "object";
  } else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const variants = (s.anyOf ?? s.oneOf) as unknown[];
    base = variants.map(short).join("|");
  } else if (typeof s.type === "string") {
    base = s.type;
  } else {
    base = "any";
  }
  // Range / length annotations.
  const range: string[] = [];
  if (typeof s.minimum === "number") range.push(`>=${s.minimum}`);
  if (typeof s.exclusiveMinimum === "number") range.push(`>${s.exclusiveMinimum}`);
  if (typeof s.maximum === "number") range.push(`<=${s.maximum}`);
  if (typeof s.exclusiveMaximum === "number") range.push(`<${s.exclusiveMaximum}`);
  if (range.length) base += range.join(",");
  if (s.default !== undefined) base += `=${JSON.stringify(s.default)}`;
  return base;
}

// Property map { field -> short type }, marking optional fields with a trailing "?".
function fields(schema: unknown): Record<string, string> {
  if (schema === undefined || schema === null || typeof schema !== "object") return {};
  const s = schema as Record<string, unknown>;
  const props = s.properties as Record<string, unknown> | undefined;
  if (props === undefined) return {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(props)) {
    const isReq = required.has(key);
    const hasDefault = typeof val === "object" && val !== null && (val as Record<string, unknown>).default !== undefined;
    out[`${key}${isReq || hasDefault ? "" : "?"}`] = short(val);
  }
  return out;
}

const tracer = new LiminaTracer("ses_dump");
const registry = new SkillRegistry(tracer);
// Default out-of-box surface: no provider map, so the runtime-gated `delegate`
// (orchestration) skill is intentionally excluded — this is exactly the catalog an
// agent gets by default. Everything else (scene/ecs/three/physics/agent/system/ui/
// audio/social/terrain/world/package + the Phase-12 playable skills) registers here.
registerCoreSkills(registry);

// registry.list() is the SAME surface MCP tools/list returns: name, description,
// input_schema (JSON Schema draft-07), category, priority. describe() adds version,
// permissions, and the output Zod schema.
const tools = registry.list();
const skills = tools
  .map((tool) => {
    const def = registry.describe(tool.name);
    if (def === undefined) return undefined;
    return {
      name: tool.name,
      version: def.version,
      category: def.category,
      priority: tool.priority,
      description: tool.description,
      permissions: [...def.permissions],
      input: fields(tool.input_schema),
      output: fields(z.toJSONSchema(def.output, { target: "draft-07", unrepresentable: "any" })),
      input_schema: tool.input_schema,
    };
  })
  .filter((s): s is NonNullable<typeof s> => s !== undefined)
  .sort((a, b) => a.name.localeCompare(b.name));

// Every distinct permission a skill declares, plus the static profile allow-lists.
const permissions = [...new Set(skills.flatMap((s) => s.permissions))].sort();
const permissionProfiles = Object.fromEntries(
  Object.entries(PERMISSION_PROFILES).map(([name, list]) => [name, [...list]]),
);
const categories = [...new Set(skills.map((s) => s.category))].sort();

const catalog = {
  engine: "limina",
  description:
    "Canonical machine-readable catalog of Limina built-in skills. Each skill maps 1:1 to an MCP tool whose name IS the skill name; the tool input is validated against a JSON Schema (draft-07) derived from the skill's Zod schema. Generated from the real registry (js/src/skills/*) via tools/dump-skills.ts.",
  docs: "https://www.liminaengine.com/skills",
  count: skills.length,
  categories,
  transports: {
    "in-process": "Mcp class (listTools/callTool)",
    stdio: "limina --mcp-stdio",
    websocket: "limina --mcp-ws --port <N>",
  },
  mcp: {
    listTools: "returns [{ name, description, input_schema, category, priority }] where input_schema is JSON Schema draft-07",
    callTool: "{ tool, input, context? } -> { success, result?, error?: { code, message }, metadata? }",
    errorCodes: ["not_found", "invalid_input", "forbidden", "handler_error", "capacity_exceeded"],
  },
  permissions,
  permissionProfiles,
  skills,
};

console.log("===LIMINA_SKILLS_BEGIN===");
console.log(JSON.stringify(catalog, null, 2));
console.log("===LIMINA_SKILLS_END===");
