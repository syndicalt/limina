// S0 -- DesignStudio abstraction.
// Proves the ordered studio definitions, collaborator expert stance, and deterministic
// readiness spine that the studio phase builds on.
//
// Run: ./target/release/limina js/test/p_design_studio.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import {
  DESIGN_STUDIOS,
  getStudio,
  overallProgress,
  studioReadiness,
} from "../src/game/design-studio.ts";
import { createDesignArtifactStore, type DesignArtifactKind } from "../src/world/design-artifacts.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_studio FAIL: " + message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

const expected = [
  { id: "concept", artifactKind: "gds", upstreamKinds: [] },
  { id: "artDirection", artifactKind: "artDirection", upstreamKinds: ["gds"] },
  { id: "world", artifactKind: "worldBible", upstreamKinds: ["gds", "artDirection"] },
  { id: "cast", artifactKind: "cast", upstreamKinds: ["gds", "artDirection", "worldBible"] },
  { id: "storyboard", artifactKind: "storyboard", upstreamKinds: ["gds", "artDirection", "worldBible", "cast"] },
] as const;

assert(DESIGN_STUDIOS.length === 5, "must define exactly five studios");
for (let i = 0; i < expected.length; i += 1) {
  const actual = DESIGN_STUDIOS[i];
  const wanted = expected[i];
  assert(actual.id === wanted.id, `studio ${i} id must be ${wanted.id}`);
  assert(actual.artifactKind === wanted.artifactKind, `${wanted.id} artifactKind must be ${wanted.artifactKind}`);
  assert(deepEqual(actual.upstreamKinds, wanted.upstreamKinds), `${wanted.id} upstreamKinds mismatch`);
}

for (const studio of DESIGN_STUDIOS) {
  assert(studio.expert.systemPrompt.includes("collaborator"), `${studio.id} prompt must say collaborator`);
  assert(
    studio.expert.systemPrompt.includes("never the ultimate decider unless"),
    `${studio.id} prompt must contain the locked decider guardrail`,
  );
  assert(studio.expert.tools.includes("design.get"), `${studio.id} expert must be able to read design artifacts`);
  assert(studio.expert.tools.includes("design.set"), `${studio.id} expert must be able to set its artifact`);
  assert(studio.expert.tools.includes("design.patch"), `${studio.id} expert must be able to patch its artifact`);
}

const empty = createDesignArtifactStore();
const emptyReadiness = studioReadiness(empty);
assert(emptyReadiness[0].studioId === "concept" && emptyReadiness[0].status === "ready", "empty store concept must be ready");
assert(deepEqual(emptyReadiness[0].missingUpstreams, []), "empty store concept missingUpstreams must be empty");
assert(emptyReadiness[1].studioId === "artDirection" && emptyReadiness[1].status === "blocked", "empty store artDirection must be blocked");
assert(deepEqual(emptyReadiness[1].missingUpstreams, ["gds"]), "empty store artDirection must miss gds");
assert(emptyReadiness[2].studioId === "world" && emptyReadiness[2].status === "blocked", "empty store world must be blocked");
assert(deepEqual(emptyReadiness[2].missingUpstreams, ["gds", "artDirection"]), "empty store world missing upstreams mismatch");
assert(emptyReadiness[3].studioId === "cast" && emptyReadiness[3].status === "blocked", "empty store cast must be blocked");
assert(deepEqual(emptyReadiness[3].missingUpstreams, ["gds", "artDirection", "worldBible"]), "empty store cast missing upstreams mismatch");
assert(emptyReadiness[4].studioId === "storyboard" && emptyReadiness[4].status === "blocked", "empty store storyboard must be blocked");
assert(deepEqual(emptyReadiness[4].missingUpstreams, ["gds", "artDirection", "worldBible", "cast"]), "empty store storyboard missing upstreams mismatch");

const withGds = createDesignArtifactStore();
withGds.artifacts.set("gds", RELIC_SPRINT);
const withGdsReadiness = studioReadiness(withGds);
assert(withGdsReadiness[0].studioId === "concept" && withGdsReadiness[0].status === "filled", "with gds concept must be filled");
assert(withGdsReadiness[1].studioId === "artDirection" && withGdsReadiness[1].status === "ready", "with gds artDirection must be ready");
assert(withGdsReadiness[2].studioId === "world" && withGdsReadiness[2].status === "blocked", "with gds world must remain blocked");
assert(deepEqual(withGdsReadiness[2].missingUpstreams, ["artDirection"]), "with gds world must only miss artDirection");
assert(withGdsReadiness[3].studioId === "cast" && withGdsReadiness[3].status === "blocked", "with gds cast must remain blocked");
assert(deepEqual(withGdsReadiness[3].missingUpstreams, ["artDirection", "worldBible"]), "with gds cast missing upstreams mismatch");
assert(withGdsReadiness[4].studioId === "storyboard" && withGdsReadiness[4].status === "blocked", "with gds storyboard must remain blocked");
assert(deepEqual(withGdsReadiness[4].missingUpstreams, ["artDirection", "worldBible", "cast"]), "with gds storyboard missing upstreams mismatch");

const progress = overallProgress(withGds);
assert(progress.filledCount === 1, `with gds filledCount must be 1, got ${progress.filledCount}`);
assert(progress.nextActionable === "artDirection", "with gds nextActionable must be artDirection");
assert(deepEqual(progress.studios, withGdsReadiness), "overallProgress.studios must mirror studioReadiness");

assertThrows(() => getStudio("not-a-studio"), "getStudio must throw on unknown id");

// Make the imported type materially part of the gate's compile surface.
const allArtifactKinds: readonly DesignArtifactKind[] = DESIGN_STUDIOS.map((studio) => studio.artifactKind);
assert(deepEqual(allArtifactKinds, expected.map((studio) => studio.artifactKind)), "studio artifact kinds must be valid design artifact kinds");

ops.op_log(
  "p_design_studio OK: five studios are ordered with correct artifacts/upstreams; expert prompts include the collaborator and never-the-decider guardrail; empty and gds-filled store readiness transitions are correct; overallProgress picks artDirection next; getStudio rejects unknown ids.",
);
