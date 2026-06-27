// P11 — named material palette. An agent picks a material by intent ("sand",
// "wood") and createEntity/setMaterial apply the preset PBR params, while the
// existing numeric color/roughness/metalness path stays exactly as before.
// Headless (stub scene; real bitECS + Rapier + materials).

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { MATERIALS, getMaterialParams } from "../src/materials/palette.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

const sceneChildren: unknown[] = [];
const scene = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);

const registry = new SkillRegistry(new LiminaTracer("ses_p11_palette"));
registerCoreSkills(registry);
const base = { agentId: "agt_builder", sessionId: "ses_p11_palette", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// --- 1. getMaterialParams returns the expected preset (deterministic) ---------
const wood = getMaterialParams("wood");
assert(wood.color === MATERIALS.wood.color && wood.color === 0x8a5a2b, "wood color preset wrong");
assert(approx(wood.roughness, MATERIALS.wood.roughness) && approx(wood.roughness, 0.72), "wood roughness preset wrong");
assert(approx(wood.metalness, MATERIALS.wood.metalness) && approx(wood.metalness, 0.0), "wood metalness preset wrong");
// Returned object is a copy: mutating it must not corrupt the shared preset.
wood.color = 0x000000;
assert(getMaterialParams("wood").color === 0x8a5a2b, "getMaterialParams must return a fresh copy");
// Deterministic: same name -> identical params every time.
assert(JSON.stringify(getMaterialParams("sand")) === JSON.stringify(getMaterialParams("sand")), "palette not deterministic");

// All required names exist.
for (const name of ["sand", "stone", "rock", "wood", "plank", "foliage", "leaf", "grass", "metal", "water"]) {
  assert(name in MATERIALS, `palette missing required material "${name}"`);
}

// --- 2. createEntity({ material }) applies the palette material ---------------
const sandPreset = getMaterialParams("sand");
const sandEntity = field(ok(await registry.invoke("scene.createEntity", { shape: "box", material: "sand", position: [0, 1, 0] }, base)), "entity");
assert(typeof sandEntity === "string", "createEntity(material:sand) returned no id");
const sandMat = world.entities.resolve(sandEntity as string)?.mesh?.material;
assert(sandMat !== undefined, "sand entity has no material");
assert(sandMat.color.getHex() === sandPreset.color, `sand entity color ${sandMat.color.getHex().toString(16)} != preset ${sandPreset.color.toString(16)}`);
assert(approx(sandMat.roughness, sandPreset.roughness), "sand entity roughness != preset");
assert(approx(sandMat.metalness, sandPreset.metalness), "sand entity metalness != preset");

// --- 3. Anti-bypass: the palette path must NOT collapse to the default path ---
// A default-color entity (white, roughness 0.6, metalness 0.1). If createEntity
// ignored `material` and fell back to defaults this would match — and fail.
const defaultEntity = field(ok(await registry.invoke("scene.createEntity", { shape: "box", position: [2, 1, 0] }, base)), "entity");
const defaultMat = world.entities.resolve(defaultEntity as string)?.mesh?.material;
assert(defaultMat !== undefined, "default entity has no material");
assert(defaultMat.color.getHex() === 0xffffff && approx(defaultMat.roughness, 0.6) && approx(defaultMat.metalness, 0.1), "default numeric path changed (back-compat broken)");
assert(sandMat.color.getHex() !== defaultMat.color.getHex(), "palette bypassed: sand material equals the default-color material");
assert(!approx(sandMat.roughness, defaultMat.roughness), "palette bypassed: sand roughness equals the default roughness");

// --- 4. Back-compat: numeric color/roughness/metalness path unchanged ---------
const numericEntity = field(ok(await registry.invoke("scene.createEntity", { shape: "sphere", color: 0xff0000, position: [4, 1, 0] }, base)), "entity");
const numericMat = world.entities.resolve(numericEntity as string)?.mesh?.material;
assert(numericMat !== undefined, "numeric entity has no material");
assert(numericMat.color.getHex() === 0xff0000 && approx(numericMat.roughness, 0.6) && approx(numericMat.metalness, 0.1), "numeric createEntity path differs from legacy behavior");

// --- 5. setMaterial by palette name applies the preset ------------------------
const stonePreset = getMaterialParams("stone");
ok(await registry.invoke("three.setMaterial", { entity: numericEntity, material: "stone" }, base));
assert(numericMat.color.getHex() === stonePreset.color, "setMaterial(material:stone) did not apply preset color");
assert(approx(numericMat.roughness, stonePreset.roughness), "setMaterial(material:stone) did not apply preset roughness");
assert(approx(numericMat.metalness, stonePreset.metalness), "setMaterial(material:stone) did not apply preset metalness");

// Explicit numeric fields override the preset (additive, not destructive).
ok(await registry.invoke("three.setMaterial", { entity: numericEntity, material: "metal", roughness: 0.05 }, base));
const metalPreset = getMaterialParams("metal");
assert(numericMat.color.getHex() === metalPreset.color && approx(numericMat.metalness, metalPreset.metalness), "setMaterial preset+override lost preset fields");
assert(approx(numericMat.roughness, 0.05), "explicit roughness should override the preset");

// --- 6. setMaterial numeric-only path still works (back-compat) ---------------
ok(await registry.invoke("three.setMaterial", { entity: numericEntity, roughness: 0.2 }, base));
assert(approx(numericMat.roughness, 0.2), "numeric setMaterial path broken");

// --- 7. Unknown name errors cleanly (no silent default) ----------------------
let threw = false;
try { getMaterialParams("unobtanium"); } catch (e) { threw = true; assert(String(e).includes("unobtanium"), "error should name the bad material"); }
assert(threw, "getMaterialParams should throw on unknown name");

const badCreate = await registry.invoke("scene.createEntity", { material: "notamaterial", position: [0, 0, 0] }, base);
assert(!badCreate.success, "createEntity with unknown material should fail");
const badSet = await registry.invoke("three.setMaterial", { entity: sandEntity, material: "notamaterial" }, base);
assert(!badSet.success, "setMaterial with unknown material should fail");
// The bad setMaterial must not have mutated the sand entity's material.
assert(sandMat.color.getHex() === sandPreset.color, "failed setMaterial should leave material untouched");

ops.op_log(`P11 material palette OK: ${Object.keys(MATERIALS).length} named materials, createEntity+setMaterial by name, numeric back-compat intact, unknown-name errors cleanly`);
