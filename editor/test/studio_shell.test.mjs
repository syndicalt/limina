// studio-shell manifest + profile wiring (studio-unification U1).
// Proves: the manifest is internally consistent (unique ids, profiles reference
// known panels and respect membership), the "design" profile is the docs/maps-only
// subset the unification plan promises, and applyVisibility toggles `hidden` on
// manifest elements only. Falsifiability: an unordered or element-toggling bug
// fails the visibility assertions; a membership violation fails registry
// construction itself (the registry throws — that IS the test).

import assert from "node:assert/strict";
import test from "node:test";

import { createStudioShell, STUDIO_PANELS, STUDIO_PROFILES } from "../src/studio-shell.js";

test("manifest ids are unique and profiles reference known member panels", () => {
  const ids = STUDIO_PANELS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate panel id in manifest");
  // Construction performs the validation: defineProfile throws on unknown ids or
  // membership violations, so a broken manifest fails here loudly.
  createStudioShell();
});

test("design profile is the docs/maps-only subset; studio is the full surface", () => {
  const { registry } = createStudioShell();
  registry.setProfile("design");
  assert.deepEqual(registry.visibleIds(), ["docs", "places", "graph", "team", "chat"]);
  registry.setProfile("studio");
  assert.equal(registry.visibleIds().length, STUDIO_PANELS.length, "studio profile shows every panel");
  // World-surface panels must not leak into the design profile, even via show().
  registry.setProfile("design");
  assert.throws(() => registry.show("world"), /not a member/);
});

test("applyVisibility toggles hidden on manifest elements only", () => {
  const elements = new Map();
  for (const p of STUDIO_PANELS) {
    if (p.elementId === undefined) continue;
    elements.set(p.elementId, { hidden: false });
  }
  const doc = { getElementById: (id) => elements.get(id) ?? null };
  const { registry, applyVisibility } = createStudioShell();
  registry.setProfile("design");
  const visible = applyVisibility(doc);
  assert.deepEqual(visible, ["docs", "places", "graph", "team", "chat"]);
  assert.equal(elements.get("world").hidden, true, "world accordion hidden in design profile");
  assert.equal(elements.get("viewport").hidden, true, "viewport hidden in design profile");
  assert.equal(elements.get("roster").hidden, false, "team accordion visible in design profile");
  assert.equal(elements.get("chat").hidden, false, "chat visible in design profile");
  registry.setProfile("studio");
  applyVisibility(doc);
  assert.equal(elements.get("world").hidden, false, "studio profile restores world panels");
});

test("applyVisibility requires a document and tolerates missing elements", () => {
  const { applyVisibility } = createStudioShell();
  assert.throws(() => applyVisibility(null), /requires a document/);
  const doc = { getElementById: () => null };
  assert.doesNotThrow(() => applyVisibility(doc), "absent elements are skipped");
});
