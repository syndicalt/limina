// GOLDEN CHARACTERIZATION GATE for compileArchitecture (the ~4,700-line offline
// architectural compiler, js/src/architecture/compiler.ts).
//
// PURPOSE: pin the compiler's EXACT output for a representative building spec so the
// planned phase-by-phase decomposition of compileArchitecture (foundations → volumes →
// roofs → dormers → penetrations → walls → openings → entrances → … → contracts) is
// provably behavior-preserving. Any extraction that changes the compiled bytes — even
// subtly — flips one of the pinned hashes here and fails LOUDLY, so the refactor cannot
// silently alter geometry, review-stage hashes, or primitive count.
//
// The compiler is a cardinal-rule component (CLAUDE.md §2 rule 2 — the authoring
// boundary), so it must be refactored under a golden pin, not by eye. If a change to
// the compiler is INTENTED to alter output, re-pin these constants IN THE SAME COMMIT
// with a note explaining what changed and why — never edit them to make an accidental
// drift pass.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_architecture_compile_golden.ts

import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";
import { canonicalCompilerJson } from "../src/world/compiler/canonical.mjs";
import { sha256 } from "../src/world/sha256.mjs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_architecture_compile_golden FAIL: ${message}`);
}

// A representative hall-house spec exercising every major compiler phase: foundations,
// a wall with a door opening, an entrance stair assembly, a two-plane roof with a
// valley seam, and a chimney fireplace with a rear-soot firebox.
const spec: ArchitectureSpec = {
  schema: "limina.architecture-spec/v1",
  id: "hall-house/compiler-fixture/v1",
  foundations: [{ id: "main", center: [0, 0], halfExtents: [5, 4], topY: 0, depth: 1.4 }],
  walls: [{ id: "south", from: [-4.8, -3.4], to: [4.8, -3.4], bottomY: 0, topY: 3.55, thickness: 0.36, openings: [{ id: "front-door", kind: "door", offset: -0.72, width: 1.44, sillY: 0.09, height: 2.48 }] }],
  entrances: [{ id: "front-entry", wallId: "south", openingId: "front-door", exteriorSide: 1, exteriorGradeY: -0.31, landingDepth: 0.64, stepCount: 2, treadDepth: 0.38, width: 1.72 }],
  roofPlanes: [
    { id: "south-slope", origin: [0, 3, 0], normal: [-0.7071067811865476, 0.7071067811865476, 0], boundary: [[-2, 1, -3], [2, 5, -3], [2, 5, 3], [-2, 1, 3]], thickness: 0.14 },
    { id: "cross-slope", origin: [0, 3, 0], normal: [0.7071067811865476, 0.7071067811865476, 0], boundary: [[2, 1, -3], [-2, 5, -3], [-2, 5, 3], [2, 1, 3]], thickness: 0.14 },
  ],
  roofSeams: [{ id: "joined-valley", kind: "valley", planeIds: ["south-slope", "cross-slope"], from: [0, 3, -2], to: [0, 3, 2], flashingWidth: 0.22 }],
  fireplaces: [{ id: "hall-hearth", center: [2.8, 1.05, 2.5], apertureHalfExtents: [0.7, 0.72, 0.6], chimneyTopY: 7.2, roofPlaneId: "south-slope", fireboxPolicy: "rear-soot-lining" }],
};

// PINNED GOLDEN OUTPUT — the compiled result for the fixture above. Re-pin only for an
// INTENDED compiler change, in the same commit, with a rationale.
const GOLDEN_OUTPUT_SHA256 = "dc398a98a78ae0347b6547f5edb67a28f992a39807f5c6c035fd56cef1fecd95";
const GOLDEN_SPEC_HASH = "sha256:7cac401c90e297af126137f56cb88e3eb6897ae5765c5a5d633f707b068f3d14";
const GOLDEN_IR_HASH = "sha256:faf5dab1e6810cd99e5694ba1d69d977852bb8ccf4b717cc317b2409e662d6d3";
const GOLDEN_PRIMITIVE_COUNT = 69;

const compiled = compileArchitecture(spec);
const outputHash = sha256(canonicalCompilerJson(compiled));

assert(outputHash === GOLDEN_OUTPUT_SHA256, `compiled OUTPUT drifted: ${outputHash} !== ${GOLDEN_OUTPUT_SHA256} (the compiler's output changed — if intended, re-pin GOLDEN_OUTPUT_SHA256 with a rationale)`);
assert(compiled.specHash === GOLDEN_SPEC_HASH, `specHash drifted: ${compiled.specHash}`);
assert(compiled.irHash === GOLDEN_IR_HASH, `irHash drifted: ${compiled.irHash}`);
assert(compiled.primitives.length === GOLDEN_PRIMITIVE_COUNT, `primitive count drifted: ${compiled.primitives.length} !== ${GOLDEN_PRIMITIVE_COUNT}`);

// Determinism: a second compile of a deep clone must be byte-identical (the pin is
// meaningless if the compiler is not deterministic to begin with).
const again = compileArchitecture(structuredClone(spec));
assert(sha256(canonicalCompilerJson(again)) === GOLDEN_OUTPUT_SHA256, "compiler is non-deterministic across identical inputs — golden pin cannot hold");

// FALSIFIABILITY: a one-field perturbation of the input MUST change the output hash,
// proving the pin actually tracks the compiled bytes (not a constant that ignores them).
const perturbed = structuredClone(spec);
perturbed.foundations[0].halfExtents = [5.5, 4];
const perturbedHash = sha256(canonicalCompilerJson(compileArchitecture(perturbed)));
assert(perturbedHash !== GOLDEN_OUTPUT_SHA256, "FALSIFIABILITY DEAD: perturbing the foundation did not change the compiled output hash — the golden pin is not tracking the output");

console.log(`p_architecture_compile_golden OK: hall-house fixture compiles to ${GOLDEN_PRIMITIVE_COUNT} primitives, output sha256 pinned (${GOLDEN_OUTPUT_SHA256.slice(0, 12)}…); deterministic; perturbation falsifies the pin. Safe to decompose compiler.ts behind this.`);
