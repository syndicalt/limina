// Boot loading overlay gate (editor/src/boot-loading.js). Proves: the overlay mounts on
// connect and starts on the deterministic contour shimmer; phase captions advance through
// the real boot seams (replay count, runLive steps, fetch progress, activation); a fetch
// event { fetched: 3, total: 10 } renders 30% and lights exactly 3/10 cells of the REAL
// manifest chunk grid (the internal lit counter, not pixels); the manifest switch replaces
// the shimmer with a grid whose cell count == manifest chunks; activation fades the
// overlay out and stops the one rAF loop; the error path freezes the overlay with the
// message. Plus the determinism guard: no Math.random in the module source.
// Falsifiability: fails if a caption regresses, if lit cells drift from fetched/total, if
// the grid is not the manifest's chunk count, if the overlay survives done(), or if any
// Math.random sneaks into the module.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createBootLoading } from "../src/boot-loading.js";

// Minimal DOM double (pattern credited to editor/test/tool_registry.test.mjs).
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { for (const c of cs) this.set.add(c); }
  remove(...cs) { for (const c of cs) this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.textContent = "";
  }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode === null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (cls && c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function makeManifest(count) {
  // A 5-wide strip: tx 0..4, tz = index / 5 — enough to prove the layout is the manifest's.
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push({ tx: i % 5, tz: Math.floor(i / 5) });
  return {
    schema: "limina.derived-revision-manifest/v2",
    manifestHash: "sha256:" + "0123456789abcdef".repeat(4),
    chunks,
  };
}

// Manual rAF + timers: the test drives every frame and the fade timeout explicitly.
function makeOverlay() {
  const doc = { createElement: (tag) => new FakeElement(tag) };
  const mount = doc.createElement("div");
  const rafQueue = [];
  const timeouts = [];
  const overlay = createBootLoading({
    document: doc,
    mount,
    raf: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    timers: { setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout: () => {} },
    fadeMs: 420,
  });
  const fireFrame = (t) => {
    const fn = rafQueue.shift();
    if (fn) fn(t);
  };
  const fireFade = () => { for (const t of timeouts.splice(0)) t.fn(); };
  return { overlay, mount, rafQueue, timeouts, fireFrame, fireFade };
}

test("overlay shows on connect: mounted, shimmering, first caption", () => {
  const { overlay, mount, rafQueue } = makeOverlay();
  assert.equal(mount.children.length, 1, "overlay root is mounted over the viewport");
  const root = mount.children[0];
  assert.ok(root.classList.contains("boot-loading"));
  assert.equal(root.dataset.phase, "connect");
  assert.equal(root.querySelector(".boot-loading-caption").textContent, "surveying the log");
  assert.ok(root.querySelector("canvas") ?? root.querySelector(".boot-loading-canvas"), "the shimmer canvas exists");
  assert.equal(overlay.cellCount, 0, "no grid before the manifest is known");
  assert.ok(rafQueue.length > 0, "the one rAF loop is running");
});

test("phase captions advance through the real boot seams", () => {
  const { overlay, mount } = makeOverlay();
  const root = mount.children[0];
  const caption = () => root.querySelector(".boot-loading-caption").textContent;
  const detail = () => root.querySelector(".boot-loading-detail").textContent;
  overlay.setReplay(517);
  assert.equal(root.dataset.phase, "replay");
  assert.equal(caption(), "surveying the log");
  assert.equal(detail(), "517 authoring commands");
  overlay.runtimeStep("loading", "loading 12 assets");
  assert.equal(caption(), "gathering the props");
  overlay.runtimeStep("loading", "starting WebGPU");
  assert.equal(caption(), "warming the renderer");
  overlay.setFetch(1, 10);
  assert.equal(caption(), "carrying the island home");
  overlay.setManifest(makeManifest(10));
  overlay.setActivating(42);
  assert.equal(root.dataset.phase, "activate");
  assert.equal(caption(), "raising the land");
  assert.equal(detail(), "r42");
  // A stale early-phase note must not regress an active later phase.
  overlay.runtimeStep("loading", "loading 3 assets");
  assert.equal(caption(), "raising the land");
});

test("fetch progress { fetched: 3, total: 10 } renders 30% and lights 3/10 cells", () => {
  const { overlay, mount } = makeOverlay();
  const root = mount.children[0];
  overlay.setManifest(makeManifest(10));
  assert.equal(overlay.cellCount, 10, "grid cell count == manifest chunks");
  overlay.setFetch(3, 10);
  assert.equal(root.querySelector(".boot-loading-pct").textContent, "30%");
  assert.equal(root.querySelector(".boot-loading-detail").textContent, "3 / 10");
  assert.equal(overlay.litCount, 3, "the internal cell-lit counter tracks fetched/total");
  overlay.setFetch(10, 10);
  assert.equal(overlay.litCount, 10);
  assert.equal(root.querySelector(".boot-loading-pct").textContent, "100%");
});

test("fetch before manifest: the fraction applies when the grid arrives", () => {
  const { overlay } = makeOverlay();
  overlay.setFetch(3, 10);
  assert.equal(overlay.cellCount, 0, "still the shimmer — no fake grid");
  assert.equal(overlay.litCount, 0);
  overlay.setManifest(makeManifest(10));
  assert.equal(overlay.cellCount, 10);
  assert.equal(overlay.litCount, 3, "the pending fraction lights the real grid on arrival");
});

test("manifest switch replaces the shimmer with the real chunk layout", () => {
  const { overlay } = makeOverlay();
  const manifest = makeManifest(4872);
  overlay.setManifest(manifest);
  assert.equal(overlay.cellCount, manifest.chunks.length, "cell count == manifest chunks");
  overlay.setManifest(undefined);
  overlay.setManifest({ chunks: [{ tx: Number.NaN, tz: 0 }] });
  assert.equal(overlay.cellCount, manifest.chunks.length, "a malformed manifest never clobbers the real grid");
});

test("indeterminate fetch without counts: pulse, no invented percentage", () => {
  const { overlay, mount } = makeOverlay();
  overlay.setFetch(undefined, undefined);
  assert.equal(mount.children[0].dataset.phase, "fetch");
  assert.equal(mount.children[0].querySelector(".boot-loading-pct").textContent, "");
});

test("overlay removes on activation: fade, removal, rAF loop stopped", () => {
  const { overlay, mount, rafQueue, fireFrame, fireFade } = makeOverlay();
  const root = mount.children[0];
  fireFrame(16);
  assert.ok(rafQueue.length > 0, "the loop re-registered before done");
  overlay.setActivating(7);
  overlay.done();
  assert.ok(root.classList.contains("boot-loading-fade"), "the fade-out class is applied");
  assert.equal(mount.children.length, 1, "still mounted during the fade");
  fireFade();
  assert.equal(mount.children.length, 0, "the overlay is removed after the fade");
  fireFrame(32); // the frame queued before disposal fires once…
  assert.equal(rafQueue.length, 0, "…and does NOT re-register — the loop is stopped");
});

test("error path: the message shows and the overlay stays (never spins forever)", () => {
  const { overlay, mount, rafQueue, fireFrame } = makeOverlay();
  const root = mount.children[0];
  fireFrame(16);
  overlay.fail("DERIVED_EDIT_INITIAL_ACTIVATION_FAILED");
  assert.equal(root.dataset.phase, "error");
  assert.equal(root.querySelector(".boot-loading-caption").textContent, "boot failed");
  assert.equal(root.querySelector(".boot-loading-detail").textContent, "DERIVED_EDIT_INITIAL_ACTIVATION_FAILED");
  assert.equal(root.querySelector(".boot-loading-pct").textContent, "", "no percentage on a failure");
  assert.equal(mount.children.length, 1, "the overlay STAYS on the error");
  fireFrame(32); // the frame queued before the freeze fires once…
  assert.equal(rafQueue.length, 0, "…and does NOT re-register — it cannot look like progress");
  // Late boot events must not overwrite the failure.
  overlay.setFetch(5, 10);
  assert.equal(root.dataset.phase, "error");
  assert.equal(root.querySelector(".boot-loading-detail").textContent, "DERIVED_EDIT_INITIAL_ACTIVATION_FAILED");
});

test("determinism guard: no Math.random anywhere in the module", () => {
  const source = readFileSync(new URL("../src/boot-loading.js", import.meta.url), "utf8");
  assert.ok(!/Math\.random/.test(source), "boot-loading.js must be deterministic — no Math.random");
});
