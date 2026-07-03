// Headless test for the viewport selection-guard predicate (editor/src/scene-graph.js).
//
// This is the core of the delete-crash fix: when the selected entity is destroyed by ANY path
// (World panel, agent, recorded-stream re-author) the gizmo must detach, or TransformControls floods
// "The attached 3D object must be a part of the scene graph" every frame and wedges the app. The
// guard detaches the moment isAttachedToScene() flips false. This proves that predicate headlessly.
//
// Run: node editor/test/scene_graph.test.mjs   (exit 0 = pass)

import { isAttachedToScene } from "../src/scene-graph.js";

function assert(cond, msg) { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } }

// A minimal scene-graph node: only `.parent` matters to the predicate (THREE-agnostic).
function node() { return { parent: null }; }
function add(parent, child) { child.parent = parent; return child; }
function remove(child) { child.parent = null; } // THREE's scene.remove() nulls the parent

const scene = node();

// 1. A mesh added directly to the scene is attached.
const mesh = add(scene, node());
assert(isAttachedToScene(mesh, scene) === true, "direct child of scene must be attached");

// 2. A nested mesh (under a group under the scene) is attached — the walk climbs to the root.
const group = add(scene, node());
const nested = add(group, node());
assert(isAttachedToScene(nested, scene) === true, "nested descendant must be attached");

// 3. THE BUG SCENARIO: the selected mesh is destroyed → scene.remove() nulls its parent → detached.
remove(mesh);
assert(isAttachedToScene(mesh, scene) === false, "a removed mesh must read as detached (drives the gizmo detach)");

// 4. Re-parenting a subtree off the scene detaches everything under it (a group delete).
remove(group);
assert(isAttachedToScene(nested, scene) === false, "descendant of a removed subtree must be detached");

// 5. Null / missing inputs never crash and read as detached.
assert(isAttachedToScene(null, scene) === false, "null object → detached");
assert(isAttachedToScene(mesh, null) === false, "null scene → detached");
assert(isAttachedToScene(undefined, undefined) === false, "undefined inputs → detached");

// 6. A cyclic graph must terminate (bounded walk) and not hang the render loop.
const a = node(), b = node();
a.parent = b; b.parent = a;
assert(isAttachedToScene(a, scene) === false, "cyclic parent chain must terminate + read detached");

console.log("PASS editor/test/scene_graph.test.mjs: isAttachedToScene detects a destroyed selection (the gizmo-detach trigger) across direct/nested/subtree deletes; null + cyclic inputs are safe.");
