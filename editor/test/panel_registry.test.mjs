// Proves the panel-registry contract behind the studio shell's dock/panel layout
// (plans/studio-unification.md, Chunk U1): unique strictly-validated registration; explicit
// ordered profiles with membership enforcement; per-profile show/hide overrides; JSON-safe
// state/restore through injected storage; exactly one onChange per committed mutation; the
// docs/maps-only "design" profile as a first-class layout.
//
// Falsifiability: profiles are declared in non-registration order and extras are shown out of
// registration order, then compared with exact array equality — an unordered Set-based visible
// list, insertion-ordered extras, or a lenient restore (accepting redundant overrides) each
// fail specific assertions below.

import assert from "node:assert/strict";
import test from "node:test";

import { createPanelRegistry } from "../src/panel-registry.js";

// The studio panel set from the unification plan: design tabs (membership undefined = every
// profile), 3D-only chrome (studio-only), and optional panels hidden by default. Registration
// order (… chat, trace, board) intentionally differs from the studio profile order.
function studioShell(options) {
  const reg = createPanelRegistry(options);
  reg.register({ id: "docs", title: "Docs" });
  reg.register({ id: "atlas", title: "Atlas" });
  reg.register({ id: "places", title: "Places" });
  reg.register({ id: "graph", title: "Graph" });
  reg.register({ id: "viewport", title: "Viewport", profileMembership: ["studio"] });
  reg.register({ id: "outliner", title: "Outliner", profileMembership: ["studio"] });
  reg.register({ id: "history", title: "History", profileMembership: ["studio"] });
  reg.register({ id: "chat", title: "Chat", profileMembership: ["studio"], defaultVisible: false });
  reg.register({ id: "trace", title: "Trace", defaultVisible: false });
  reg.register({ id: "board", title: "Board", defaultVisible: false });
  reg.defineProfile("studio", ["viewport", "docs", "outliner", "atlas", "places", "graph", "history"]);
  reg.defineProfile("design", ["docs", "atlas", "places", "graph"]);
  return reg;
}

// Storage adapter contract: load(key) → unknown, save(key, value). The JSON round-trip on save
// proves persisted snapshots are serializable and detached from registry internals.
function mapStorage(map = new Map()) {
  return {
    load: (key) => map.get(key),
    save: (key, value) => map.set(key, JSON.parse(JSON.stringify(value))),
  };
}

test("options are strictly validated; memory-only is the default", () => {
  assert.throws(() => createPanelRegistry(null), TypeError);
  assert.throws(() => createPanelRegistry({ storage: {} }), TypeError);
  assert.throws(() => createPanelRegistry({ storageKey: "" }), TypeError);
  assert.throws(() => createPanelRegistry({ onChange: "x" }), TypeError);
  assert.throws(() => createPanelRegistry({ bogus: true }), TypeError);
  const reg = createPanelRegistry();
  reg.register({ id: "docs", title: "Docs" });
  reg.show("docs"); // mutations without storage must not throw
  assert.deepEqual(reg.state(), { profile: null, overrides: { show: [], hide: [] } });
});

test("registration validates descriptors and rejects duplicate ids", () => {
  const reg = createPanelRegistry();
  reg.register({ id: "docs", title: "Docs" });
  assert.throws(() => reg.register({ id: "docs", title: "Duplicate" }), /duplicate panel "docs"/);
  assert.throws(() => reg.register(null), TypeError);
  assert.throws(() => reg.register({ title: "No id" }), TypeError);
  assert.throws(() => reg.register({ id: "", title: "Empty id" }), TypeError);
  assert.throws(() => reg.register({ id: "x" }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: "" }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: 42 }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: "t", profileMembership: "studio" }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: "t", profileMembership: ["a", "a"] }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: "t", defaultVisible: "yes" }), TypeError);
  assert.throws(() => reg.register({ id: "x", title: "t", zone: "left" }), TypeError);
});

test("defineProfile rejects unknown panels, duplicates, and membership violations", () => {
  const reg = createPanelRegistry();
  reg.register({ id: "docs", title: "Docs" });
  reg.register({ id: "viewport", title: "Viewport", profileMembership: ["studio"] });
  assert.throws(() => reg.defineProfile("", ["docs"]), TypeError);
  assert.throws(() => reg.defineProfile("design", "docs"), TypeError);
  assert.throws(() => reg.defineProfile("design", ["docs", "docs"]), TypeError);
  assert.throws(() => reg.defineProfile("design", ["docs", "ghost"]), /unknown panel "ghost"/);
  assert.throws(() => reg.defineProfile("design", ["docs", "viewport"]), /not a member of profile "design"/);
  reg.defineProfile("design", ["docs"]);
  assert.throws(() => reg.defineProfile("design", ["docs"]), /duplicate profile "design"/);
});

test("default layout: defaultVisible panels in registration order, before any profile is set", () => {
  const reg = studioShell();
  assert.deepEqual(reg.visibleIds(), ["docs", "atlas", "places", "graph", "viewport", "outliner", "history"]);
  assert.deepEqual(reg.state(), { profile: null, overrides: { show: [], hide: [] } });
  reg.show("board");
  reg.hide("docs");
  assert.deepEqual(reg.visibleIds(), ["atlas", "places", "graph", "viewport", "outliner", "history", "board"]);
});

test("setProfile switches the visible set, clears overrides, rejects unknown profiles", () => {
  const reg = studioShell();
  reg.setProfile("design");
  reg.hide("docs");
  reg.show("trace");
  assert.throws(() => reg.setProfile("nowhere"), /unknown profile "nowhere"/);
  assert.throws(() => reg.setProfile(""), TypeError);
  reg.setProfile("studio");
  assert.deepEqual(reg.state(), { profile: "studio", overrides: { show: [], hide: [] } });
  assert.deepEqual(reg.visibleIds(), ["viewport", "docs", "outliner", "atlas", "places", "graph", "history"]);
});

test("show/hide overrides compose with the active profile; visibleIds ordering is canonical", () => {
  const reg = studioShell();
  reg.setProfile("design");
  reg.hide("atlas");
  assert.deepEqual(reg.visibleIds(), ["docs", "places", "graph"]);
  // re-shown panel returns to its declared slot, not the end
  reg.show("atlas");
  assert.deepEqual(reg.visibleIds(), ["docs", "atlas", "places", "graph"]);
  // extras append in registration order: board shown before trace, trace registered first
  reg.show("board");
  reg.show("trace");
  assert.deepEqual(reg.visibleIds(), ["docs", "atlas", "places", "graph", "trace", "board"]);
  reg.hide("trace"); // hiding an extra removes it
  assert.deepEqual(reg.visibleIds(), ["docs", "atlas", "places", "graph", "board"]);
  assert.throws(() => reg.show("ghost"), /unknown panel "ghost"/);
  assert.throws(() => reg.hide("ghost"), /unknown panel "ghost"/);
  assert.throws(() => reg.show(42), TypeError);
  assert.throws(() => reg.show("viewport"), /not a member of profile "design"/);
});

test("state/restore round-trips through Map-backed storage; restore(state()) is an identity", () => {
  const storage = mapStorage();
  const a = studioShell({ storage, storageKey: "layout" });
  a.setProfile("design");
  a.hide("graph");
  a.show("trace");
  const snapshot = a.state();
  assert.deepEqual(snapshot, { profile: "design", overrides: { show: ["trace"], hide: ["graph"] } });
  assert.deepEqual(storage.load("layout"), snapshot);

  // A fresh registry over the same storage boots into the persisted layout.
  const b = studioShell({ storage, storageKey: "layout" });
  b.restore(storage.load("layout"));
  assert.deepEqual(b.state(), snapshot);
  assert.deepEqual(b.visibleIds(), a.visibleIds());
  b.restore(b.state());
  assert.deepEqual(b.state(), snapshot);
  // Cross-profile restore replaces overrides wholesale.
  b.restore({ profile: "studio", overrides: { show: ["chat"], hide: ["docs"] } });
  assert.deepEqual(b.visibleIds(), ["viewport", "outliner", "atlas", "places", "graph", "history", "chat"]);
});

test("restore rejects malformed snapshots and unknown names, leaving state untouched", () => {
  const reg = studioShell();
  const base = { profile: "design", overrides: { show: ["trace"], hide: ["graph"] } };
  const malformed = [
    null, 42, "design", [],
    { profile: "design" },
    { ...base, extra: true },
    { profile: 5, overrides: base.overrides },
    { profile: "", overrides: base.overrides },
    { profile: "design", overrides: null },
    { profile: "design", overrides: { show: ["trace"] } },
    { profile: "design", overrides: { show: [], hide: [], extra: [] } },
    { profile: "design", overrides: { show: "trace", hide: [] } },
    { profile: "design", overrides: { show: ["trace", "trace"], hide: [] } },
    { profile: "design", overrides: { show: ["trace"], hide: ["trace"] } },
    // well-typed but non-canonical: state() never emits these
    { profile: "design", overrides: { show: ["docs"], hide: [] } },
    { profile: "design", overrides: { show: [], hide: ["trace"] } },
  ];
  for (const snapshot of malformed) assert.throws(() => reg.restore(snapshot), TypeError);
  assert.throws(() => reg.restore({ profile: "nowhere", overrides: { show: [], hide: [] } }), /unknown profile "nowhere"/);
  assert.throws(() => reg.restore({ profile: "design", overrides: { show: ["ghost"], hide: [] } }), /unknown panel "ghost"/);
  assert.throws(() => reg.restore({ profile: "design", overrides: { show: ["viewport"], hide: [] } }), /not a member of profile "design"/);
  assert.deepEqual(reg.state(), { profile: null, overrides: { show: [], hide: [] } });
});

test("onChange fires exactly once per committed mutation with the post-mutation snapshot", () => {
  const calls = [];
  const reg = studioShell({ onChange: (snapshot) => calls.push(snapshot) });
  assert.equal(calls.length, 0); // registration and profile definitions are not mutations
  reg.setProfile("design");
  reg.hide("docs");
  reg.show("trace");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { profile: "design", overrides: { show: [], hide: [] } });
  assert.deepEqual(calls[1], { profile: "design", overrides: { show: [], hide: ["docs"] } });
  assert.deepEqual(calls[2], { profile: "design", overrides: { show: ["trace"], hide: ["docs"] } });
  assert.deepEqual(calls[2], reg.state());
  // every notification is a fresh object graph
  assert.notEqual(calls[0], calls[1]);
  assert.notEqual(calls[1].overrides, calls[2].overrides);
  assert.notEqual(calls[2].overrides.show, calls[2].overrides.hide);
  // rejected mutations do not notify
  assert.throws(() => reg.setProfile("nowhere"));
  assert.throws(() => reg.show("ghost"));
  assert.throws(() => reg.restore(null), TypeError);
  assert.equal(calls.length, 3);
});

test("every mutation persists before onChange fires when storage is provided", () => {
  const storage = mapStorage();
  const persistedAtNotify = [];
  const reg = studioShell({ storage, storageKey: "k", onChange: () => persistedAtNotify.push(storage.load("k")) });
  reg.setProfile("design");
  reg.hide("docs");
  assert.equal(persistedAtNotify.length, 2);
  assert.deepEqual(persistedAtNotify[0], { profile: "design", overrides: { show: [], hide: [] } });
  assert.deepEqual(persistedAtNotify[1], { profile: "design", overrides: { show: [], hide: ["docs"] } });
  assert.deepEqual(persistedAtNotify[1], reg.state());
});

test("design profile: docs/maps-only layout from the unification plan", () => {
  const reg = studioShell();
  reg.setProfile("design");
  assert.deepEqual(reg.visibleIds(), ["docs", "atlas", "places", "graph"]);
  // studio chrome is unreachable from the design profile
  for (const id of ["viewport", "outliner", "history", "chat"]) {
    assert.throws(() => reg.show(id), /not a member of profile "design"/);
  }
  // switching back restores the full dock
  reg.setProfile("studio");
  assert.deepEqual(reg.visibleIds(), ["viewport", "docs", "outliner", "atlas", "places", "graph", "history"]);
});
