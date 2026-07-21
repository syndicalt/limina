// P73 — DESIGN DIRECTION. The machine-readable art-style artifact that governs builds. Proves the
// schema is deterministic + falsifiable (house style of p68_world_config), the DD-aware material
// resolution (materials/palette.ts resolveRoleColor/resolveRoleMaterial) returns the DD's declared
// colors, and two DIFFERENT design directions yield DIFFERENT resolved palettes for the same role —
// i.e. the DD genuinely governs the surface, it is not a rubber stamp. Also asserts the gds.ts hook
// accepts BOTH a structured DD and a legacy free-text note (the seam) and normalizes either.

import { ops } from "../src/engine.ts";
import {
  DEFAULT_DESIGN_DIRECTION,
  DesignDirectionSchema,
  parseDesignDirection,
  serializeDesignDirection,
  validateDesignDirection,
  type DesignDirection,
} from "../src/game/design-direction.ts";
import { resolveRoleColor, resolveRoleMaterial } from "../src/materials/palette.ts";
import { GameDesignSpecSchema, resolveDesignDirection } from "../src/game/gds.ts";
import { MATERIALS } from "../src/materials/palette.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p73_design_direction: " + msg);
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}
/** A fresh, structurally-valid mutable clone of the default (via the serialized form). */
function fresh(): Record<string, unknown> {
  return JSON.parse(serializeDesignDirection(DEFAULT_DESIGN_DIRECTION)) as Record<string, unknown>;
}

// ── 1. Round-trip determinism ──────────────────────────────────────────────────────────────
const jsonA = serializeDesignDirection(DEFAULT_DESIGN_DIRECTION);
const jsonB = serializeDesignDirection(DEFAULT_DESIGN_DIRECTION);
assert(jsonA === jsonB, "serializeDesignDirection must be byte-identical across repeated calls");
assert(deepEqual(parseDesignDirection(jsonA), DEFAULT_DESIGN_DIRECTION), "DEFAULT_DESIGN_DIRECTION must parse/serialize round-trip (deepEqual)");
assert(serializeDesignDirection(parseDesignDirection(jsonA)) === jsonA, "serialize(parse(serialize(DEFAULT))) must equal serialize(DEFAULT)");

// ── 2. Reject invalid ──────────────────────────────────────────────────────────────────────
// Bad style enum ("cel-shaded" is not a member).
{
  const bad = fresh();
  bad.style = "cel-shaded";
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject unknown style enum 'cel-shaded'");
}
// Out-of-range unit interval (chunkiness01 = 2).
{
  const bad = fresh();
  (bad.proportion as Record<string, unknown>).chunkiness01 = 2;
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject chunkiness01 = 2 (out of 0..1)");
}
// Out-of-range roughness envelope (max = 5).
{
  const bad = fresh();
  ((bad.material as Record<string, unknown>).roughness01 as Record<string, unknown>).max = 5;
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject roughness01.max = 5 (out of 0..1)");
}
// Malformed hex color.
{
  const bad = fresh();
  (bad.palette as Array<Record<string, unknown>>)[0].colorHex = "reddish";
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject a non-#rrggbb colorHex");
}
// Unknown palette role (enum-closed).
{
  const bad = fresh();
  (bad.palette as Array<Record<string, unknown>>)[0].role = "lava";
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject unknown palette role 'lava'");
}
// Extra/unknown top-level key (.strict).
{
  const bad = fresh();
  bad.bogusUnknownKey = 42;
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject unknown top-level key (.strict)");
}
// Extra/unknown nested key (.strict on sub-objects).
{
  const bad = fresh();
  (bad.proportion as Record<string, unknown>).bogusNested = true;
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject unknown nested key (.strict sub-object)");
}
// Missing required — palette / material / style / version.
for (const key of ["palette", "material", "style", "version"]) {
  const bad = fresh();
  delete bad[key];
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), `must reject DD missing required '${key}'`);
}
// Empty palette (min 1).
{
  const bad = fresh();
  bad.palette = [];
  assertThrows(() => parseDesignDirection(JSON.stringify(bad)), "must reject an empty palette (min 1)");
}

// ── 3. Semantic validation (beyond structural) ───────────────────────────────────────────────
// A per-role material hint whose roughness sits OUTSIDE the global envelope is a semantic error.
{
  const bad = fresh();
  const mat = bad.material as Record<string, unknown>;
  (mat.roughness01 as Record<string, unknown>).min = 0.5;
  (mat.roughness01 as Record<string, unknown>).max = 0.9;
  mat.roles = [{ role: "water", recipe: "stylized water", roughness01: 0.14, metalness01: 0.0 }];
  const v = validateDesignDirection(bad);
  assert(!v.ok, "validateDesignDirection must flag a role hint outside the envelope");
  assert(v.issues.some((i) => i.path.startsWith("material.roles")), "issue must point at the offending role hint");
}
// The DEFAULT passes semantic validation (its role hints stay inside the envelope).
assert(validateDesignDirection(DEFAULT_DESIGN_DIRECTION).ok, "DEFAULT_DESIGN_DIRECTION must pass semantic validation");

// ── 4. DD-aware material resolution — returns the DECLARED color, deterministically ───────────
{
  const stoneHex = DEFAULT_DESIGN_DIRECTION.palette.find((p) => p.role === "stone")!.colorHex;
  const stoneInt = parseInt(stoneHex.slice(1), 16);
  assert(resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "stone") === stoneInt, "resolveRoleColor(stone) must equal the declared hex as an int");
  // Grounded default agrees with the shipped MATERIALS preset for stone (the DD did not invent a color).
  assert(resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "stone") === MATERIALS.stone.color, "default DD stone color must equal MATERIALS.stone");
  // Deterministic: same (dd, role) -> identical result.
  assert(resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "wood") === resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "wood"), "resolveRoleColor must be deterministic");
  // Unknown role throws cleanly (mirrors getMaterialParams — no silent fallback).
  assertThrows(() => resolveRoleColor({ ...DEFAULT_DESIGN_DIRECTION, palette: [{ role: "stone", colorHex: "#111111" }] } as DesignDirection, "water"), "resolveRoleColor must throw when the DD declares no color for the role");
  // resolveRoleMaterial: role WITH a hint returns the hint's params; role WITHOUT a hint returns the envelope midpoint.
  const metalMat = resolveRoleMaterial(DEFAULT_DESIGN_DIRECTION, "metal");
  assert(metalMat.metalness === 1.0 && Math.abs(metalMat.roughness - 0.38) < 1e-9, "resolveRoleMaterial(metal) must use the per-role hint");
  const skyMat = resolveRoleMaterial(DEFAULT_DESIGN_DIRECTION, "sky"); // sky has no per-role hint
  const rr = DEFAULT_DESIGN_DIRECTION.material.roughness01;
  assert(Math.abs(skyMat.roughness - (rr.min + rr.max) / 2) < 1e-9, "resolveRoleMaterial(sky) must fall back to the envelope midpoint");
}

// ── 5. TWO DIFFERENT DDs yield DIFFERENT resolved palettes for the SAME role (governs, not stamps) ─
{
  const clay: DesignDirection = parseDesignDirection(serializeDesignDirection(DEFAULT_DESIGN_DIRECTION));
  const CLAY_STONE = "#c4b7a6"; // a warmer, paler clay stone
  const CLAY_FOLIAGE = "#7fae5a";
  clay.id = "claymation";
  clay.style = "claymation";
  clay.proportion = { unitScaleM: 1.0, chunkiness01: 0.85, silhouette: "exaggerated" };
  clay.palette = clay.palette.map((p) =>
    p.role === "stone" ? { role: "stone", colorHex: CLAY_STONE } : p.role === "foliage" ? { role: "foliage", colorHex: CLAY_FOLIAGE } : p
  );
  const clayParsed = parseDesignDirection(serializeDesignDirection(clay)); // prove it's a valid DD
  assert(clayParsed.style === "claymation", "the claymation DD must parse");
  assert(resolveRoleColor(clayParsed, "stone") !== resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "stone"), "claymation vs stylized-realism must resolve DIFFERENT stone colors");
  assert(resolveRoleColor(clayParsed, "foliage") !== resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "foliage"), "the two DDs must resolve DIFFERENT foliage colors");
  assert(resolveRoleColor(clayParsed, "stone") === parseInt(CLAY_STONE.slice(1), 16), "claymation stone must resolve to ITS declared color");
}

// ── 6. gds.ts hook: accepts a structured DD AND a legacy string; resolveDesignDirection normalizes ─
{
  // The union member: a GDS carrying a structured DesignDirection object validates.
  const baseSpec = {
    id: "t", pitch: "p", loopSentence: "l",
    controls: { scheme: "keyboard-mouse", intents: [{ name: "move", binding: "KeyW" }] },
    winCondition: "w", loseCondition: "lo",
    targetPlatforms: ["web"], scopeTier: "prototype", optIn: "direct-path",
    entities: [{ id: "player", name: "P", role: "player" }],
    dod: [{ id: "d1", statement: "s", kind: "state-transition", drives: { steps: [{ forward: 1 }], assert: [{ check: "flagTrue", target: "x" }] } }],
  };
  const structured = GameDesignSpecSchema.parse({ ...baseSpec, artDirection: DEFAULT_DESIGN_DIRECTION });
  assert(typeof structured.artDirection === "object", "GDS must accept a structured DesignDirection for artDirection");
  assert(resolveDesignDirection(structured).id === DEFAULT_DESIGN_DIRECTION.id, "resolveDesignDirection must return the structured DD as-is");
  // The legacy member: a free-text note still validates (back-compat) and normalizes to the default DD.
  const legacy = GameDesignSpecSchema.parse({ ...baseSpec, artDirection: "warm lantern light against a hazed corruption" });
  assert(typeof legacy.artDirection === "string", "GDS must still accept a legacy free-text artDirection");
  assert(resolveDesignDirection(legacy).id === DEFAULT_DESIGN_DIRECTION.id, "resolveDesignDirection must fall back to the default DD for a legacy note");
  // A structurally-broken DD embedded as artDirection is rejected (the hook is a real schema, not `any`).
  assertThrows(() => GameDesignSpecSchema.parse({ ...baseSpec, artDirection: { version: 1, id: "x", style: "not-a-style", palette: [], material: {}, proportion: {}, referenceLibrary: [] } }), "GDS must reject a malformed structured artDirection");
}

// Sanity: DesignDirectionSchema.shape is accessible (a pure strict object, mirrors world-config).
assert(Object.keys(DesignDirectionSchema.shape).includes("palette"), "DesignDirectionSchema.shape must expose 'palette'");

ops.op_log("[js] p73_design_direction OK: DesignDirection schema validates, rejects invalid (bad style/enum/range/hex/strict/missing), round-trips byte-stable; resolveRoleColor/resolveRoleMaterial return the DECLARED on-brief colors deterministically; two DDs (claymation vs stylized-realism) resolve DIFFERENT palettes for the same role; the gds.ts hook accepts BOTH a structured DD and a legacy note and normalizes either");
