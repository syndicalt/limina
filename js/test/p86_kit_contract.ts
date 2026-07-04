// P86 — Building MODULE-KIT contract + wall-panel RELIEF gate (Slice 0 + Slice 1).
//
// Proves, with no renderer, on the pure part library (js/src/skills/building/kit.ts):
//   (A) CONTRACT — makePart returns a real mesh + collider for every PartKind; the registry has no gaps.
//   (B) RELIEF — the wall-panel is NOT a flat box: its timber frame stands PROUD of the plaster (the
//       front-Z geometry extent exceeds a same-size flat box), it carries TWO materials (plaster +
//       timber), and it has far more geometry than one box. This is the "surface not shape" proof.
//   (C) ON-BRIEF — materials resolve their colour from the active DesignDirection (plaster=stone role,
//       frame=wood role), so a build honours the declared palette.
//   (D) DETERMINISM — the same (spec, ctx) yields byte-identical geometry, so a recorded build replays
//       bit-for-bit. partSeed is a pure, stable mixer.
//
// Run: ./target/release/limina js/test/p86_kit_contract.ts   (exit 0 = pass)

import { KIT, PART_KINDS, type KitPartSpec, type PartContext, makePart, partSeed } from "../src/skills/building/kit.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../src/game/design-direction.ts";
import { resolveRoleColor } from "../src/materials/palette.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p86_kit_contract FAIL: " + msg);
}

const ctx: PartContext = { dd: DEFAULT_DESIGN_DIRECTION, seed: 42 };
const SIZE: [number, number, number] = [4, 3, 0.25];

// ── (A) CONTRACT: every kind resolves and produces a usable part ──────────────────────────────────
assert(Object.keys(KIT).length === PART_KINDS.length, "KIT registry must cover every PART_KIND with no gaps");
for (const kind of PART_KINDS) {
  const out = makePart({ kind, size: SIZE, role: "stone" }, ctx);
  assert(out.mesh !== undefined && out.mesh.geometry !== undefined, `part "${kind}" produced no mesh`);
  const posCount = out.mesh.geometry.attributes.position.count;
  assert(posCount > 0, `part "${kind}" produced empty geometry`);
  assert(
    out.colliderHalf.length === 3 && out.colliderHalf.every((v) => v > 0),
    `part "${kind}" produced a degenerate collider ${JSON.stringify(out.colliderHalf)}`,
  );
}
console.log(`[js] p86 (A) CONTRACT OK — all ${PART_KINDS.length} part kinds resolve to a real mesh + collider`);

// ── (B) RELIEF: the wall-panel stands proud of a flat box, has two materials + more geometry ──────
const wall = makePart({ kind: "wall-panel", size: SIZE, role: "stone" }, ctx);
const box = makePart({ kind: "beam", size: SIZE, role: "stone" }, ctx); // beam = single flat box, same size
wall.mesh.geometry.computeBoundingBox();
box.mesh.geometry.computeBoundingBox();
const wallFrontZ = wall.mesh.geometry.boundingBox!.max.z;
const boxFrontZ = box.mesh.geometry.boundingBox!.max.z;
assert(wallFrontZ > boxFrontZ + 0.02, `wall-panel frame must stand proud: wallFrontZ=${wallFrontZ} vs flat boxFrontZ=${boxFrontZ}`);
assert(Array.isArray(wall.mesh.material) && (wall.mesh.material as unknown[]).length === 2, "wall-panel must carry two materials (plaster + timber)");
assert(wall.mesh.geometry.groups.length >= 2, "wall-panel geometry must have >=2 material groups");
const wallVerts = wall.mesh.geometry.attributes.position.count;
const boxVerts = box.mesh.geometry.attributes.position.count;
assert(wallVerts > boxVerts * 3, `wall-panel must be far richer than a box: ${wallVerts} vs ${boxVerts}`);
// Collider reflects the proud frame.
assert(wall.colliderHalf[2] > SIZE[2] / 2, `wall-panel collider z-half ${wall.colliderHalf[2]} must exceed flat ${SIZE[2] / 2}`);
console.log(`[js] p86 (B) RELIEF OK — wall proud frontZ=${wallFrontZ.toFixed(3)} > box ${boxFrontZ.toFixed(3)}; verts ${wallVerts} vs ${boxVerts}; 2 materials`);

// ── (C) ON-BRIEF: materials take their colour from the DesignDirection ────────────────────────────
const mats = wall.mesh.material as { color: { getHex(): number } }[];
const stoneHex = resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "stone");
const woodHex = resolveRoleColor(DEFAULT_DESIGN_DIRECTION, "wood");
assert(mats[0].color.getHex() === stoneHex, `plaster colour ${mats[0].color.getHex().toString(16)} != DD stone ${stoneHex.toString(16)}`);
assert(mats[1].color.getHex() === woodHex, `timber colour ${mats[1].color.getHex().toString(16)} != DD wood ${woodHex.toString(16)}`);
console.log(`[js] p86 (C) ON-BRIEF OK — plaster=DD.stone #${stoneHex.toString(16)}, frame=DD.wood #${woodHex.toString(16)}`);

// ── (D) DETERMINISM: same (spec, ctx) -> identical geometry ───────────────────────────────────────
const spec: KitPartSpec = { kind: "wall-panel", size: SIZE, role: "stone" };
const a = makePart(spec, ctx).mesh.geometry.attributes.position.array as Float32Array;
const b = makePart(spec, ctx).mesh.geometry.attributes.position.array as Float32Array;
assert(a.length === b.length, "determinism: vertex counts differ across identical calls");
for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `determinism: vertex ${i} differs (${a[i]} vs ${b[i]})`);
// partSeed is pure + salt-sensitive.
assert(partSeed(42, 1) === partSeed(42, 1), "partSeed must be pure");
assert(partSeed(42, 1) !== partSeed(42, 2), "partSeed must vary with salt");
console.log(`[js] p86 (D) DETERMINISM OK — identical geometry over ${a.length} floats; partSeed pure + salt-sensitive`);

// ── (E) STAIR: a real stepped run, not a ramp block ───────────────────────────────────────────────
const stair = makePart({ kind: "stair", size: [1.4, 0.5, 1.0], role: "stone", params: { steps: 3 } }, ctx);
stair.mesh.geometry.computeBoundingBox();
const sbb = stair.mesh.geometry.boundingBox!;
assert(stair.mesh.geometry.attributes.position.count > 24 * 2, `stair must be multiple steps, got ${stair.mesh.geometry.attributes.position.count} verts`);
assert(Math.abs((sbb.max.y - sbb.min.y) - 0.5) < 1e-3, `stair must span its full rise (~0.5), got ${(sbb.max.y - sbb.min.y).toFixed(3)}`);
assert(Math.abs((sbb.max.z - sbb.min.z) - 1.0) < 1e-3, `stair must span its full run (~1.0), got ${(sbb.max.z - sbb.min.z).toFixed(3)}`);
console.log(`[js] p86 (E) STAIR OK — ${stair.mesh.geometry.attributes.position.count} verts, rise ${(sbb.max.y - sbb.min.y).toFixed(2)} run ${(sbb.max.z - sbb.min.z).toFixed(2)}`);

console.log("[js] p86_kit_contract OK — KitPart contract holds, wall-panel + stair have real relief + on-brief materials, deterministic.");
