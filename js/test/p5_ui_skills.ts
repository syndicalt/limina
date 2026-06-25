// Phase 5-A / A4 — `ui.*` skill surface + Zod style schema + UiManager.
//
// Proves a builder over MCP authors expressive containers exactly as it authors
// the world — agent-native, permission-checked, Zod-validated, traced — driving
// the REAL A2/A3 container layer (a live Panel whose mesh is in the scene and a
// live UiManager entry), not a parallel reimplementation:
//
//   1. BUILDER FLOW — builder.readWrite (has ui.write) -> ui.speechBubble /
//      ui.panel with a FULL Zod style object succeed + return a handle; the
//      panel's mesh is in the scene AND the manager; ui.update re-composites the
//      text; ui.remove takes it out of the scene + manager.
//   2. PERMISSION — a profile WITHOUT ui.write (player.limited / system.readonly)
//      is DENIED with ZERO effect (no panel, no scene mesh) + emits
//      security.permission.denied. Falsifiable: the SAME args under a builder DO
//      create a panel, so the gate is what blocks.
//   3. ZOD — a malformed style (bad color / unknown kind / negative size) is
//      rejected (invalid_input), no panel. Falsifiable: the same shape with a
//      valid value composes.
//   4. TRACE — each successful call emits skill.executed + a ui.* event.
//   5. HOST TICK — UiManager.update(camera,w,h,dt) ticks anchors + lifecycles
//      (billboard places the quad, fade ramps opacity) and auto-dismisses TTLs.
//
// Run (headless): ./target/debug/limina js/test/p5_ui_skills.ts

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type SceneLike } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import type { TextStyle } from "../src/ui/compositor.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 A4 FAIL: " + message);
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}

// ---- headless world: a scene that tracks its children ----------------------

const sceneChildren: unknown[] = [];
const scene: SceneLike = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};
const camera = new THREE.PerspectiveCamera(60, 960 / 640, 0.1, 200);
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

const tracer = new LiminaTracer("ses_p5_ui");
const registry = new SkillRegistry(tracer);
const { ui } = registerCoreSkills(registry);

const BUILDER = { agentId: "agt_builder", sessionId: "ses_p5_ui", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const PLAYER = { agentId: "agt_player", sessionId: "ses_p5_ui", permissions: resolveProfile("player.limited"), tick: 0, world };
const READONLY = { agentId: "agt_inspector", sessionId: "ses_p5_ui", permissions: resolveProfile("system.readonly"), tick: 0, world };

// A FULL style object exercising the Zod mirror of TextStyle.
const FULL_STYLE: TextStyle = {
  background: { color: 0xf7f9fc, opacity: 0.98 },
  border: { width: 2, color: 0x2a3550, radius: 12 },
  title: { background: 0x2d3850, color: 0x9fd0ff, height: 26, align: "left", scale: 2 },
  text: { color: 0x14202e, scale: 2, align: "left", lineHeight: 24, letterSpacing: 0 },
  padding: { top: 8, right: 12, bottom: 8, left: 12 },
  shadow: { color: 0x000000, offsetY: 4, blur: 6, opacity: 0.4 },
  maxWidth: 260,
};

// =============================================================================
// 1. BUILDER FLOW: create -> in scene + manager; update -> re-composites;
//    remove -> gone.
// =============================================================================

const created = await registry.invoke("ui.speechBubble", {
  anchor: { kind: "world", point: [-4, 2.5, 0], offset: [0, 0, 0], billboard: true },
  style: FULL_STYLE,
  text: "Hello there, traveller!",
  title: "GUIDE",
  tail: { toward: { x: 0, y: -1 } },
}, BUILDER);
assert(created.success, `(1) builder ui.speechBubble failed: ${JSON.stringify(created.error)}`);
const handle = field(created.result, "handle");
assert(typeof handle === "string" && handle.startsWith("ui_"), `(1) ui.speechBubble returned no handle: ${JSON.stringify(created.result)}`);
const h = handle as string;

// The panel is REAL: its mesh is in the scene AND tracked by the manager.
assert(ui.has(h), "(1) manager does not hold the created handle");
assert(ui.size === 1, `(1) manager size ${ui.size}, expected 1`);
const mesh = ui.mesh(h);
assert(mesh !== undefined && sceneChildren.includes(mesh), "(1) panel mesh was not added to the scene");

// ui.update re-composites the text (real Panel.setText -> new composited buffer).
const panel = ui.panel(h);
assert(panel !== undefined, "(1) manager.panel(handle) returned nothing");
const beforeBuf = panel.composited;
const updated = await registry.invoke("ui.update", { handle: h, text: "Mind the loose stones ahead." }, BUILDER);
assert(updated.success, `(1) ui.update failed: ${JSON.stringify(updated.error)}`);
assert(field(updated.result, "ok") === true && field(updated.result, "changed") === true, `(1) ui.update did not report a change: ${JSON.stringify(updated.result)}`);
const afterBuf = panel.composited;
assert(beforeBuf !== afterBuf, "(1) ui.update did not re-composite the panel (same buffer)");
assert(afterBuf.width > 0 && afterBuf.height > 0, "(1) re-composited panel is empty");

// ui.update with a NEW style restyles the live panel (rebuild + swap in scene).
const restyled = await registry.invoke("ui.update", { handle: h, style: { background: { color: 0x101418, opacity: 0.9 } } }, BUILDER);
assert(restyled.success && field(restyled.result, "changed") === true, "(1) ui.update style restyle did not report a change");
assert(ui.has(h) && ui.size === 1, "(1) restyle should keep exactly one live panel");
const reMesh = ui.mesh(h);
assert(reMesh !== undefined && sceneChildren.includes(reMesh), "(1) restyled panel mesh not in scene after rebuild");
assert(!sceneChildren.includes(mesh), "(1) restyle left the OLD mesh in the scene (leak)");

// ui.remove takes it out of the scene + manager.
const removed = await registry.invoke("ui.remove", { handle: h }, BUILDER);
assert(removed.success && field(removed.result, "removed") === true, `(1) ui.remove failed: ${JSON.stringify(removed)}`);
assert(!ui.has(h) && ui.size === 0, "(1) manager still holds a removed handle");
assert(!sceneChildren.includes(reMesh), "(1) removed panel mesh still in the scene");
console.log("A4 (1) OK: builder creates (in scene + manager) -> updates (re-composites) -> restyles (swap) -> removes (gone)");

// =============================================================================
// 2. PERMISSION: no ui.write -> denied, ZERO effect; security.permission.denied.
// =============================================================================

const sizeBefore = ui.size;
const childrenBefore = sceneChildren.length;
const deniedArgs = { anchor: { kind: "world", point: [0, 2, 0] }, style: FULL_STYLE, text: "I should not appear", tail: { toward: { x: 0, y: -1 } } };

const deniedPlayer = await registry.invoke("ui.speechBubble", deniedArgs, PLAYER);
assert(!deniedPlayer.success && deniedPlayer.error?.code === "forbidden", `(2) player.limited ui.speechBubble was not forbidden: ${JSON.stringify(deniedPlayer)}`);
const deniedReadonly = await registry.invoke("ui.panel", { kind: "hudPanel", anchor: { kind: "screen", corner: "top-right" }, lines: ["nope"] }, READONLY);
assert(!deniedReadonly.success && deniedReadonly.error?.code === "forbidden", `(2) system.readonly ui.panel was not forbidden: ${JSON.stringify(deniedReadonly)}`);

// ZERO effect: nothing entered the manager or the scene.
assert(ui.size === sizeBefore, `(2) a denied call created a panel (manager size ${ui.size} != ${sizeBefore})`);
assert(sceneChildren.length === childrenBefore, `(2) a denied call added a mesh to the scene (${sceneChildren.length} != ${childrenBefore})`);

// The denial is observable in the trace.
const playerDenied = tracer.trace("agt_player").filter((e) => e.type === "security.permission.denied");
const readonlyDenied = tracer.trace("agt_inspector").filter((e) => e.type === "security.permission.denied");
assert(playerDenied.some((e) => field(e.payload, "missing") === "ui.write"), "(2) no security.permission.denied(ui.write) for player.limited");
assert(readonlyDenied.some((e) => field(e.payload, "missing") === "ui.write"), "(2) no security.permission.denied(ui.write) for system.readonly");

// Falsifiable: the SAME args under a builder DO create a panel (the gate blocked).
const sameAsBuilder = await registry.invoke("ui.speechBubble", deniedArgs, BUILDER);
assert(sameAsBuilder.success, `(2) falsifiable: the same args under a builder should succeed: ${JSON.stringify(sameAsBuilder.error)}`);
assert(ui.size === sizeBefore + 1, "(2) falsifiable: builder call did not create the panel the denied call could not");
await registry.invoke("ui.remove", { handle: field(sameAsBuilder.result, "handle") as string }, BUILDER);
assert(ui.size === sizeBefore, "(2) cleanup of the falsifiability panel failed");
console.log("A4 (2) OK: no-ui.write profiles denied with zero effect + security.permission.denied; builder with the SAME args creates one");

// =============================================================================
// 3. ZOD: malformed style/args rejected (no panel). Falsifiable vs valid.
// =============================================================================

const zSizeBefore = ui.size;
const zChildrenBefore = sceneChildren.length;

// bad color (negative packed int)
const badColor = await registry.invoke("ui.speechBubble", { anchor: { kind: "world", point: [0, 0, 0] }, style: { text: { color: -5 } }, text: "x" }, BUILDER);
assert(!badColor.success && badColor.error?.code === "invalid_input", `(3) bad color not Zod-rejected: ${JSON.stringify(badColor)}`);
// unknown kind
const badKind = await registry.invoke("ui.panel", { kind: "blob", anchor: { kind: "world", point: [0, 0, 0] }, text: "x" }, BUILDER);
assert(!badKind.success && badKind.error?.code === "invalid_input", `(3) unknown kind not Zod-rejected: ${JSON.stringify(badKind)}`);
// negative size (glyph scale must be a positive int)
const badSize = await registry.invoke("ui.textBox", { anchor: { kind: "world", point: [0, 0, 0] }, style: { text: { scale: -2 } }, text: "x" }, BUILDER);
assert(!badSize.success && badSize.error?.code === "invalid_input", `(3) negative size not Zod-rejected: ${JSON.stringify(badSize)}`);
// unknown style key (strict)
const badKey = await registry.invoke("ui.textBox", { anchor: { kind: "world", point: [0, 0, 0] }, style: { bogusKey: 1 }, text: "x" }, BUILDER);
assert(!badKey.success && badKey.error?.code === "invalid_input", `(3) unknown style key not Zod-rejected (strict): ${JSON.stringify(badKey)}`);
// malformed anchor (neither world nor screen)
const badAnchor = await registry.invoke("ui.label", { anchor: { kind: "galaxy" }, text: "x" }, BUILDER);
assert(!badAnchor.success && badAnchor.error?.code === "invalid_input", `(3) malformed anchor not Zod-rejected: ${JSON.stringify(badAnchor)}`);

// ZERO effect from every rejected call.
assert(ui.size === zSizeBefore && sceneChildren.length === zChildrenBefore, "(3) a Zod-rejected call still created a panel");

// Falsifiable: the same shape with a VALID color composes.
const goodColor = await registry.invoke("ui.speechBubble", { anchor: { kind: "world", point: [0, 0, 0] }, style: { text: { color: 0x44ff88 } }, text: "x" }, BUILDER);
assert(goodColor.success, `(3) falsifiable: a valid color should compose: ${JSON.stringify(goodColor.error)}`);
await registry.invoke("ui.remove", { handle: field(goodColor.result, "handle") as string }, BUILDER);
console.log("A4 (3) OK: bad color / unknown kind / negative size / unknown key / bad anchor all Zod-rejected (zero panels); a valid color composes");

// =============================================================================
// 4. TRACE: a successful call emits skill.executed + a ui.* event.
// =============================================================================

const traced = await registry.invoke("ui.textBox", { anchor: { kind: "world", point: [0, 3, -4] }, title: "FOREST LOG", text: "Two agents meet.", style: { gradient: { from: 0x1b2230, to: 0x0b0e14, direction: "vertical" } } }, BUILDER);
assert(traced.success, `(4) traced ui.textBox failed: ${JSON.stringify(traced.error)}`);
const tracedHandle = field(traced.result, "handle") as string;
const builderTrace = tracer.trace("agt_builder");
const exec = builderTrace.filter((e) => e.type === "skill.executed" && field(e.payload, "skill") === "ui.textBox");
const created4 = builderTrace.filter((e) => e.type === "ui.panel.created" && field(e.payload, "handle") === tracedHandle);
assert(exec.length >= 1, "(4) no skill.executed event for ui.textBox");
assert(created4.length === 1, `(4) expected exactly one ui.panel.created for the handle, got ${created4.length}`);
assert(field(created4[0].payload, "kind") === "textBox", "(4) ui.panel.created payload missing the kind");
// metadata also reports the emitted ids (registry threads them through).
assert(Array.isArray(traced.metadata?.eventsEmitted) && traced.metadata.eventsEmitted.length >= 2, "(4) skill metadata did not record >=2 emitted events");
await registry.invoke("ui.remove", { handle: tracedHandle }, BUILDER);
console.log("A4 (4) OK: a successful ui.* call emits skill.executed + ui.panel.created (in the tracer + metadata)");

// =============================================================================
// 5. HOST TICK: UiManager.update(camera,w,h,dt) ticks anchors + lifecycles +
//    auto-dismisses TTLs.
// =============================================================================

// Fade + world billboard: tick places the quad at point+offset and ramps opacity.
const faded = await registry.invoke("ui.speechBubble", {
  anchor: { kind: "world", point: [3, 1, -2], offset: [0, 2, 0], billboard: true },
  text: "fade me",
  lifecycle: { fade: { from: 0, to: 1, durationMs: 200 } },
}, BUILDER);
assert(faded.success, "(5) fade speechBubble failed");
const fadeHandle = field(faded.result, "handle") as string;
const fadePanel = ui.panel(fadeHandle);
assert(fadePanel !== undefined && fadePanel.material.opacity === 0, `(5) fade did not start at 0 (${fadePanel?.material.opacity})`);

camera.position.set(0, 3, 9);
camera.lookAt(0, 1, 0);
camera.updateMatrixWorld(true);
ui.update(camera, 960, 640, 100); // dt = 100ms -> halfway
const fadeMesh = ui.mesh(fadeHandle);
assert(fadeMesh !== undefined, "(5) manager.mesh(handle) returned nothing for the live fade panel");
assert(Math.abs(fadeMesh.position.x - 3) < 1e-4 && Math.abs(fadeMesh.position.y - 3) < 1e-4 && Math.abs(fadeMesh.position.z + 2) < 1e-4, `(5) world anchor did not place the quad at point+offset (${fadeMesh.position.x},${fadeMesh.position.y},${fadeMesh.position.z})`);
assert(Math.abs(fadePanel.material.opacity - 0.5) < 1e-6, `(5) fade did not ramp to 0.5 at half duration (${fadePanel.material.opacity})`);
ui.update(camera, 960, 640, 100); // dt = 100ms -> complete
assert(fadePanel.material.opacity === 1, `(5) fade did not complete (${fadePanel.material.opacity})`);
await registry.invoke("ui.remove", { handle: fadeHandle }, BUILDER);

// TTL auto-dismiss: a ttl panel is removed from manager + scene during a tick.
const ttl = await registry.invoke("ui.label", { anchor: { kind: "world", point: [0, 0, 0] }, text: "ephemeral", lifecycle: { ttl: 150 } }, BUILDER);
assert(ttl.success, "(5) ttl label failed");
const ttlHandle = field(ttl.result, "handle") as string;
const ttlMesh = ui.mesh(ttlHandle);
assert(ui.has(ttlHandle) && sceneChildren.includes(ttlMesh), "(5) ttl panel not present before expiry");
ui.update(camera, 960, 640, 100); // 100 < 150 -> still alive
assert(ui.has(ttlHandle), "(5) ttl panel dismissed too early");
ui.update(camera, 960, 640, 100); // total 200 > 150 -> auto-dismiss
assert(!ui.has(ttlHandle), "(5) ttl panel was not auto-dismissed from the manager");
assert(!sceneChildren.includes(ttlMesh), "(5) auto-dismissed ttl panel mesh still in the scene");
console.log("A4 (5) OK: host tick ramps fade + billboards the quad at point+offset; TTL auto-dismisses from manager + scene");

// Final invariant: every panel created in this run was removed/dismissed.
assert(ui.size === 0, `(end) ${ui.size} live panels leaked`);
assert(sceneChildren.length === 0, `(end) ${sceneChildren.length} meshes leaked in the scene`);

console.log("P5 A4 OK: ui.* skill surface — builder create/update/restyle/remove (real containers) + permission gate (zero effect) + Zod reject + trace + host tick/lifecycle");
