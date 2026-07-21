// Studio event bus + context packer (fluid agents). Proves: typed events land
// in a bounded rolling buffer with listener fan-out; the pack assembles
// surface/world/design state from injected sources with budget caps; the prompt
// block renders only what exists. Falsifiability: an unbounded buffer fails the
// capacity leg; a pack that dumped full state fails the caps.

import assert from "node:assert/strict";
import test from "node:test";

import { createStudioEventBus, STUDIO_EVENTS } from "../src/agents/studio-events.js";
import { createContextPacker } from "../src/agents/context-pack.js";

test("bus: typed emit, rolling cap, fan-out, family filter, validation", () => {
  const bus = createStudioEventBus({ capacity: 5, clock: (() => { let t = 0; return () => ++t; })() });
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  assert.throws(() => bus.emit("nodot"), TypeError);
  for (let i = 0; i < 8; i++) bus.emit(STUDIO_EVENTS.ATLAS_STROKE, { detail: `stroke ${i}` });
  bus.emit(STUDIO_EVENTS.DOC_SAVE, { detail: "world-bible.md" });
  assert.equal(bus.size, 5, "buffer is capped");
  assert.equal(seen.length, 9, "listeners see every event");
  const recent = bus.recent(3);
  assert.equal(recent.length, 3);
  assert.equal(recent[2].type, STUDIO_EVENTS.DOC_SAVE);
  assert.equal(bus.ofFamily("atlas").length, 4, "family filter over the window");
  assert.throws(() => bus.recent(0), TypeError);
  assert.throws(() => bus.subscribe("nope"), TypeError);
  // recent() returns independent copies — a caller mutating a copy never
  // touches the ambient window.
  recent[0].detail = "mutated";
  assert.notEqual(bus.recent(3)[0].detail, "mutated");
});

function makeSources() {
  return {
    shell: { activeWorkspace: () => "atlas" },
    selection: {
      activeTool: () => ({ id: "terrain.elev", title: "Elev" }),
      options: () => ({ mode: "noise", radius: 30 }),
      entities: () => ["ent_1", "ent_2"],
    },
    world: { summary: () => ({ entities: 142, bodies: 12 }) },
    atlas: { summary: () => "primary 512² landmass r12, 256² elevation r3" },
    docs: {
      active: () => ({ name: "world-bible.md", kind: "world-bible", title: "World Bible" }),
      list: () => ["world-bible.md", "cast.md"],
    },
  };
}

test("packer: assembles surface/world/design with budgets and prompt block", () => {
  const bus = createStudioEventBus();
  bus.emit(STUDIO_EVENTS.DOC_SAVE, { detail: "world-bible.md" });
  bus.emit(STUDIO_EVENTS.ATLAS_STROKE, { detail: "land raise 60m" });
  const packer = createContextPacker({ ...makeSources(), events: bus });
  const pack = packer.pack();
  assert.equal(pack.surface.workspace, "atlas");
  assert.equal(pack.surface.tool.id, "terrain.elev");
  assert.deepEqual(pack.surface.options, { mode: "noise", radius: 30 });
  assert.deepEqual(pack.surface.selection, ["ent_1", "ent_2"]);
  assert.equal(pack.world.entities, 142);
  assert.match(pack.design.atlas, /512²/);
  assert.equal(pack.design.activeDoc.name, "world-bible.md");
  assert.equal(pack.recentEvents.length, 2);

  const block = packer.packAsPromptBlock();
  assert.match(block, /CURRENT STUDIO STATE:/);
  assert.match(block, /workspace: atlas/);
  assert.match(block, /active tool: terrain\.elev \(mode=noise, radius=30\)/);
  assert.match(block, /open doc: world-bible\.md \(world-bible\) "World Bible"/);
  assert.match(block, /world: entities=142, bodies=12/);
  assert.match(block, /· atlas\.stroke — land raise 60m/);
});

test("packer: sparse sources produce a minimal block; long titles clip", () => {
  const bus = createStudioEventBus();
  const packer = createContextPacker({
    events: bus,
    docs: { active: () => ({ name: "x.md", kind: "note", title: "t".repeat(200) }) },
  });
  const pack = packer.pack();
  assert.equal(pack.surface.workspace, undefined);
  assert.equal(pack.recentEvents.length, 0);
  assert.ok(pack.design.activeDoc.title.length <= 60);
  const block = packer.packAsPromptBlock();
  assert.ok(!block.includes("workspace:"), "absent sections stay absent");
  assert.ok(!block.includes("recent activity"));
  assert.throws(() => createContextPacker({}), TypeError);
});

test("packer: selection and docs lists are capped", () => {
  const bus = createStudioEventBus();
  const packer = createContextPacker({
    events: bus,
    selection: { entities: () => Array.from({ length: 40 }, (_, i) => `ent_${i}`) },
    docs: { list: () => Array.from({ length: 60 }, (_, i) => `doc_${i}.md`) },
  });
  const pack = packer.pack();
  assert.equal(pack.surface.selection.length, 8);
  assert.equal(pack.design.docs.length, 24);
});
