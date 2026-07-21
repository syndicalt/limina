// Native COMPILE-TO-EXPORT producer for the browser Run tier. Compiles a small GDS `world` slice
// (a ground plane + a few placed props) into the portable 5-file export bundle via
// compileWorldToExport, confirms it round-trips through loadExport, then WRITES the files to
// traces/ with bare `compile.*` names (op_write_trace forbids path separators). The host gate
// tools/director/check-compile-run.mjs relocates + packages + render-verifies them.
//
// This is a native-host script (Deno globals present); it lives outside js/src so the
// host-portability guard does not scan it (same reason export-demo.ts lives here).
//
// Run: ./target/release/limina js/scripts/compile-world-export.ts

import { ops } from "../src/engine.ts";
import { validateGDS } from "../src/game/gds.ts";
import { compileWorldToExport } from "../src/game/world-compile.ts";
import { loadExport } from "../src/export/package.ts";

const OUT = {
  "manifest.json": "compile.manifest.json",
  "log.jsonl": "compile.log.jsonl",
  "keyframes.jsonl": "compile.keyframes.jsonl",
  "tiles.jsonl": "compile.tiles.jsonl",
  "assets.jsonl": "compile.assets.jsonl",
} as const;

// A minimal renderable world slice: a wide ground plane + a few props at varied heights, a couple
// with a named palette material so the render is unambiguously non-blank.
const spec = validateGDS({
  id: "compile_run_fixture",
  pitch: "compile a designed world slice into a runnable release",
  loopSentence: "move · reach · avoid · score · fall · retry",
  controls: { scheme: "keyboard-mouse", intents: [{ name: "move-forward", binding: "KeyW" }] },
  winCondition: "reach the goal",
  loseCondition: "fall",
  artDirection: "grounded stylized",
  targetPlatforms: ["web"],
  scopeTier: "prototype",
  optIn: "record+export",
  entities: [
    { id: "player", name: "Warden", role: "player" },
    { id: "ground", name: "Ground", role: "prop" },
    { id: "crate", name: "Crate", role: "prop" },
    { id: "post", name: "Post", role: "prop" },
    { id: "block", name: "Block", role: "prop" },
  ],
  content: [],
  world: {
    placements: [
      { id: "p_ground", entity: "ground", transform: { position: [0, -0.25, 0], scale: [40, 0.5, 40] }, material: { material: "sand" } },
      { id: "p_crate", entity: "crate", transform: { position: [3, 1, 0] }, material: { material: "wood" } },
      { id: "p_post", entity: "post", transform: { position: [-3, 1.5, 2], scale: [0.5, 3, 0.5] } },
      { id: "p_block", entity: "block", transform: { position: [0, 1, -4], rotation: [0, 0.6, 0], scale: [1.5, 1.5, 1.5] } },
    ],
  },
  dod: [{
    id: "d1", statement: "moving forward reaches the goal", kind: "state-transition",
    drives: { steps: [{ forward: 1, repeat: 10 }], assert: [{ check: "gameState", value: "won" }] },
  }],
});
if (!spec.ok || spec.data === undefined) throw new Error("compile-world-export: fixture GDS invalid: " + JSON.stringify(spec.issues));

const compiled = await compileWorldToExport(spec.data, { worldId: "compiled", seed: 0xc0117 });
if (compiled.result.failures.length > 0) {
  ops.op_log("compile-world-export: soft placement failures " + JSON.stringify(compiled.result.failures));
}

// Round-trip before writing: fail loud if the assembled bundle is malformed.
const check = loadExport(compiled.files);
if (check.commands.length !== compiled.commandCount) throw new Error("compile-world-export: loadExport lost commands");

for (const [key, name] of Object.entries(OUT)) {
  ops.op_write_trace(name, compiled.files[key as keyof typeof compiled.files]);
}

ops.op_log(
  `compile-world-export OK: placed=${compiled.result.placed}, ${compiled.commandCount} commands, ` +
    `wrote traces/{${Object.values(OUT).join(",")}} (relocate + package via tools/director/check-compile-run.mjs).`,
);
