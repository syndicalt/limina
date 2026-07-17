import fs from "node:fs";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value)
    throw new Error(`p_architecture_dormer_mantel_revision FAIL: ${message}`);
}
const read = (path: string) =>
  JSON.parse(fs.readFileSync(path, "utf8")) as ArchitectureSpec;
const legacy = compileArchitecture(
  read("assets/buildings/functional-hall-house-architecture-v1.json"),
);
const revisedSpec = read(
  "assets/buildings/functional-hall-house-architecture-v2.json",
);
const revised = compileArchitecture(revisedSpec);

const legacyDormer = legacy.dormers[0];
assert(legacyDormer.cutBoundary.length === 4, "v1 dormer replay changed");
assert(
  legacy.primitives.some((part) => part.id === "dormer/south/flashing-backpan"),
  "v1 backpan replay changed",
);
assert(
  legacy.primitives.filter((part) =>
    part.id.startsWith("roof/main-roof/south/fragment-"),
  ).length === 4,
  "v1 host partition changed",
);

const dormer = revised.dormers[0];
assert(dormer.hostConnection === "intersecting-gable", "new connection mode missing");
assert(dormer.cutBoundary.length === 5, "host opening is not pentagonal");
assert(
  revised.primitives.filter((part) =>
    part.id.startsWith("roof/main-roof/south/fragment-"),
  ).length === 5,
  "intersecting host partition is not five non-overlapping fragments",
);
assert(
  !revised.primitives.some((part) => part.id === "dormer/south/flashing-backpan"),
  "rectangular backpan survived the intersecting connection",
);
for (const id of dormer.valleyIds ?? [])
  assert(revised.primitives.some((part) => part.id === id), `missing ${id}`);

const host = revised.primitives.find(
  (part) =>
    part.kind === "plane-slab" &&
    part.id === "roof/main-roof/south/fragment-left",
);
assert(host?.kind === "plane-slab", "host reference plane missing");
const planeDistance = (point: readonly number[]) =>
  Math.abs(
    (point[0] - host.origin[0]) * host.normal[0] +
      (point[1] - host.origin[1]) * host.normal[1] +
      (point[2] - host.origin[2]) * host.normal[2],
  );
for (const id of dormer.roofPlaneIds) {
  const roof = revised.primitives.find(
    (part) => part.kind === "plane-slab" && part.id === id,
  );
  assert(roof?.kind === "plane-slab", `missing roof ${id}`);
  assert(
    planeDistance(roof.boundary[2]) <= 0.003 &&
      planeDistance(roof.boundary[3]) <= 0.003,
    `${id} does not terminate on its host plane`,
  );
}
const ridge = revised.primitives.find((part) => part.id === dormer.ridgeId);
assert(ridge?.kind === "linear-member", "dormer ridge missing");
assert(
  Math.abs(ridge.from[1] - ridge.to[1]) <= 0.005,
  "dormer ridge falsely slopes along its length",
);

const dormerWindow = revised.windows.find((window) => window.id === "window/dormer");
assert(dormerWindow, "dormer window missing");
const frameBottom = Math.min(
  ...dormerWindow.frame.map((part) => part.center[1] - part.halfExtents[1]),
);
const frontHostY = Math.min(dormer.cutBoundary[3][1], dormer.cutBoundary[4][1]);
assert(frameBottom - frontHostY >= 0.12, "dormer frame remains buried in the host roof");

const mantel = revised.interiorStructure.find((item) => item.id === "hearth-mantel");
assert(mantel?.parts[0]?.kind === "box", "constrained mantel missing");
const mantelBox = mantel.parts[0];
assert(
  Math.abs(mantelBox.center[1] - 2.2) <= 0.001 &&
    Math.abs(mantelBox.center[1] - mantelBox.halfExtents[1] - 2.1) <= 0.001,
  "mantel is not at the fireplace-relative elevation",
);
for (const id of ["mantel-candle", "mantel-jug"]) {
  const prop = revised.domesticProps.find((item) => item.id === id);
  assert(prop?.supportY === 2.3, `${id} did not follow the lowered mantel`);
}

const rejectedDormer = structuredClone(revisedSpec);
rejectedDormer.dormers![0].windowSillY = 4.6;
assertThrows(() => compileArchitecture(rejectedDormer), "unsafe dormer reveal passed");
const rejectedMantel = structuredClone(revisedSpec);
rejectedMantel.interiorStructure!.find((item) => item.id === "hearth-mantel")!.center[1] = 2.4;
assertThrows(() => compileArchitecture(rejectedMantel), "high mantel passed");

function assertThrows(run: () => unknown, message: string) {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

console.log(
  `p_architecture_dormer_mantel_revision OK: ${revised.primitives.length} primitives, connected dormer, constrained mantel`,
);
