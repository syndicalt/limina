// P59 — multi-light authoring: three.addLight (directional/point/spot) +
// three.removeLight, alongside the pre-existing three.setLighting (single
// ambient+directional pair), unchanged. Headless (stub child-tracking scene).

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

interface LightLike {
  isDirectionalLight?: boolean;
  isPointLight?: boolean;
  isSpotLight?: boolean;
  isAmbientLight?: boolean;
  color: { getHex(): number };
  intensity: number;
  position: { x: number; y: number; z: number };
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
  shadow?: { camera: { near: number; far: number } };
  target?: { position: { x: number; y: number; z: number } };
}

const sceneChildren: unknown[] = [];
const scene = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};

const ctx = createHeadlessContext({ scene, session: "ses_p59", agentId: "agt_builder" });
const registry = ctx.registry;
const base = ctx.base;

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    const rec = value as Record<string, unknown>;
    return rec[key];
  }
  return undefined;
}
function lightOf(id: string): LightLike {
  const found = sceneChildren.find((c) => id === idOf(c));
  if (found === undefined) throw new Error(`light ${id} not found in scene`);
  return found as LightLike;
}
// Track id -> light object ourselves (three.addLight doesn't stamp the id onto
// the object), by remembering insertion order per addLight call below.
const byId = new Map<string, unknown>();
function idOf(light: unknown): string | undefined {
  for (const [id, l] of byId) if (l === light) return id;
  return undefined;
}

// ---- directional -----------------------------------------------------------
const dirRes = ok(await registry.invoke("three.addLight", {
  kind: "directional", color: 0xff8800, intensity: 2.5, position: [4, 6, 2],
}, base));
const dirId = field(dirRes, "id");
if (typeof dirId !== "string") throw new Error("addLight(directional) returned no id");
{
  // The just-added light is the newest scene child.
  const light = sceneChildren[sceneChildren.length - 1] as LightLike;
  byId.set(dirId, light);
  if (light.isDirectionalLight !== true) throw new Error("directional: wrong kind");
  if (light.color.getHex() !== 0xff8800) throw new Error("directional: wrong color");
  if (light.intensity !== 2.5) throw new Error("directional: wrong intensity");
  if (light.position.x !== 4 || light.position.y !== 6 || light.position.z !== 2) throw new Error("directional: wrong position");
}

// ---- point (with shadow) ---------------------------------------------------
const pointRes = ok(await registry.invoke("three.addLight", {
  kind: "point", color: 0x00ffcc, intensity: 4, position: [1, 2, 3], distance: 15, decay: 1.5,
  castShadow: true, shadowCameraNear: 0.3, shadowCameraFar: 40,
}, base));
const pointId = field(pointRes, "id");
if (typeof pointId !== "string") throw new Error("addLight(point) returned no id");
{
  const light = sceneChildren[sceneChildren.length - 1] as LightLike;
  byId.set(pointId, light);
  if (light.isPointLight !== true) throw new Error("point: wrong kind");
  if (light.color.getHex() !== 0x00ffcc) throw new Error("point: wrong color");
  if (light.intensity !== 4) throw new Error("point: wrong intensity");
  if (light.position.x !== 1 || light.position.y !== 2 || light.position.z !== 3) throw new Error("point: wrong position");
  if (light.distance !== 15) throw new Error("point: wrong distance");
  if (light.decay !== 1.5) throw new Error("point: wrong decay");
  if (light.castShadow !== true) throw new Error("point: castShadow not set");
  if (light.shadow?.camera.near !== 0.3 || light.shadow?.camera.far !== 40) throw new Error("point: shadow camera near/far not applied");
}

// ---- spot (with target) ----------------------------------------------------
const spotRes = ok(await registry.invoke("three.addLight", {
  kind: "spot", color: 0xffffff, intensity: 6, position: [0, 8, 0], target: [2, 0, 2],
  angle: Math.PI / 6, penumbra: 0.4, distance: 25, decay: 2,
}, base));
const spotId = field(spotRes, "id");
if (typeof spotId !== "string") throw new Error("addLight(spot) returned no id");
{
  const light = sceneChildren[sceneChildren.length - 1] as LightLike;
  byId.set(spotId, light);
  if (light.isSpotLight !== true) throw new Error("spot: wrong kind");
  if (light.intensity !== 6) throw new Error("spot: wrong intensity");
  if (Math.abs((light.angle ?? 0) - Math.PI / 6) > 1e-9) throw new Error("spot: wrong angle");
  if (light.penumbra !== 0.4) throw new Error("spot: wrong penumbra");
  if (light.position.x !== 0 || light.position.y !== 8 || light.position.z !== 0) throw new Error("spot: wrong position");
  if (light.target === undefined || light.target.position.x !== 2 || light.target.position.z !== 2) throw new Error("spot: target not applied");
  // The spot's target Object3D must ALSO have been added to the scene (three.js
  // requires this for the target's world matrix to update).
  if (!sceneChildren.includes(light.target)) throw new Error("spot: target object not added to scene");
}

const beforeRemove = sceneChildren.length;

// ---- setLighting: original single ambient+directional pair, unchanged -----
ok(await registry.invoke("three.setLighting", {}, base));
const afterSetLighting = sceneChildren.length;
if (afterSetLighting !== beforeRemove + 2) throw new Error("setLighting did not add exactly one ambient + one directional");
const ambient = sceneChildren.find((c) => (c as LightLike).isAmbientLight === true) as LightLike | undefined;
const baseline = sceneChildren.filter((c) => (c as LightLike).isDirectionalLight === true) as LightLike[];
if (ambient === undefined) throw new Error("setLighting: no ambient light");
if (ambient.color.getHex() !== 0x404060 || ambient.intensity !== 1.2) throw new Error("setLighting: ambient defaults changed");
// setLighting's own directional (default color/intensity 0xffffff/3) must be present
// ALONGSIDE the addLight-authored directional (0xff8800/2.5) — both coexist.
const setLightingDirectional = baseline.find((l) => l.color.getHex() === 0xffffff && l.intensity === 3);
if (setLightingDirectional === undefined) throw new Error("setLighting: directional defaults changed or missing");
const authoredStillPresent = baseline.find((l) => l.color.getHex() === 0xff8800);
if (authoredStillPresent === undefined) throw new Error("setLighting clobbered an addLight-authored directional");

// Calling setLighting again REPLACES its own pair (pre-existing behavior) without
// touching the addLight-authored lights.
ok(await registry.invoke("three.setLighting", { ambientIntensity: 0.5 }, base));
if (sceneChildren.length !== afterSetLighting) throw new Error("setLighting replace changed total light count");
const ambient2 = sceneChildren.find((c) => (c as LightLike).isAmbientLight === true) as LightLike | undefined;
if (ambient2?.intensity !== 0.5) throw new Error("setLighting replace did not apply new ambientIntensity");

// ---- removeLight ------------------------------------------------------------
const countBeforeRemove = sceneChildren.length;
const pointLightObj = lightOf(pointId);
const removed = ok(await registry.invoke("three.removeLight", { id: pointId }, base));
if (field(removed, "ok") !== true) throw new Error("removeLight reported failure");
if (sceneChildren.length !== countBeforeRemove - 1) throw new Error("removeLight did not remove exactly one light");
if (sceneChildren.includes(pointLightObj)) throw new Error("removeLight left the point light in the scene");
if (!sceneChildren.includes(lightOf(dirId)) || !sceneChildren.includes(lightOf(spotId))) {
  throw new Error("removeLight disturbed an unrelated light");
}

// Removing an already-removed / unknown id fails honestly.
const removedAgain = await registry.invoke("three.removeLight", { id: pointId }, base);
if (field(ok(removedAgain), "ok") !== false) throw new Error("removeLight should report ok:false for an unknown id");

ops.op_log(`P59 OK: multi-light — directional/point/spot via three.addLight + three.removeLight; three.setLighting unchanged`);
