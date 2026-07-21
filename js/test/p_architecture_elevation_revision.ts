import fs from "node:fs";
import {
  compileArchitecture,
  type ArchitectureSpec,
  type PlaneSlab,
  type SolidBox,
} from "../src/architecture/index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value)
    throw new Error(`p_architecture_elevation_revision FAIL: ${message}`);
}
const close = (actual: number, expected: number, message: string) =>
  assert(Math.abs(actual - expected) <= 0.001, `${message}: ${actual}`);
const bottom = (box: SolidBox) => box.center[1] - box.halfExtents[1];
const top = (box: SolidBox) => box.center[1] + box.halfExtents[1];
const spec = JSON.parse(
  fs.readFileSync(
    "assets/buildings/functional-hall-house-architecture-v5.json",
    "utf8",
  ),
) as ArchitectureSpec;
const compiled = compileArchitecture(spec);

const dormer = compiled.dormers[0];
assert(
  dormer.roofWallConnection === "soffit-bearing",
  "dormer roof-wall policy missing",
);
for (const id of dormer.roofPlaneIds) {
  const roof = compiled.primitives.find((part) => part.id === id) as
    | PlaneSlab
    | undefined;
  assert(roof?.kind === "plane-slab", `missing ${id}`);
  const run = Math.abs(roof.boundary[1][0] - roof.boundary[0][0]);
  const rise = Math.abs(roof.boundary[1][1] - roof.boundary[0][1]);
  close(
    (Math.atan2(rise, run) * 180) / Math.PI,
    spec.dormers![0].roofPitchDegrees,
    `${id} pitch drifted`,
  );
}
for(const [roofId,cheekId] of dormer.roofPlaneIds.map((id,index)=>[id,index===0?"dormer/south/cheek-left":"dormer/south/cheek-right"] as const)){
  const roof=compiled.primitives.find((part)=>part.id===roofId) as PlaneSlab,cheek=compiled.primitives.find((part)=>part.id===cheekId) as PlaneSlab;
  const centerX=cheek.boundary[0][0],halfWall=cheek.thickness/2,undersideAt=(x:number)=>roof.origin[1]+(-roof.thickness/2-roof.normal[0]*(x-roof.origin[0]))/roof.normal[1],values=[undersideAt(centerX-halfWall),undersideAt(centerX+halfWall)],wallTop=Math.max(...cheek.boundary.map((point)=>point[1]));
  assert(Math.min(...values)<wallTop&&Math.max(...values)>wallTop,`${roofId} soffit does not physically bear through ${cheekId}`);
}
for (const id of ["dormer/south/cheek-left", "dormer/south/cheek-right"]) {
  const cheek = compiled.primitives.find((part) => part.id === id) as
    | PlaneSlab
    | undefined;
  assert(cheek?.kind === "plane-slab", `missing ${id}`);
  const rear = cheek.boundary.filter(
    (point) => Math.abs(point[2] - dormer.cutBoundary[0][2]) <= 0.001,
  );
  assert(rear.length === 2, `${id} rear bearing edge missing`);
  assert(
    Math.abs(rear[0][1] - rear[1][1]) >= 0.02 &&
      Math.abs(rear[0][1] - rear[1][1]) <= 0.04,
    `${id} lacks a bounded soffit seat`,
  );
}

const floorY = compiled.functionalContract!.site!.finishedFloorY;
close(bottom(compiled.fireplaces[0].base), floorY, "hearth floats above floor");
const entrance = compiled.entrances[0];
assert(entrance.steps.length === 1, "final tread still duplicates the landing");
close(Math.abs(entrance.steps[0].center[2]-entrance.landing.center[2]),entrance.steps[0].halfExtents[2]+entrance.landing.halfExtents[2],"stair is horizontally disconnected from landing");
const landingFinish = entrance.finishCourses.find((part) =>
  part.id.endsWith("finish-landing"),
)!;
const stepFinish = entrance.finishCourses.find((part) =>
  part.id.endsWith("finish-step-0"),
)!;
close(top(landingFinish), floorY, "landing finish misses finished floor");
close(bottom(landingFinish), top(entrance.landing), "landing finish floats");
close(bottom(stepFinish), top(entrance.steps[0]), "tread finish floats");
close(
  bottom(entrance.steps[0]),
  entrance.exteriorGradeY - spec.entrances[0].bearingDepth!,
  "lowest stair lacks authored grade bearing",
);

const wrongSupport = structuredClone(spec);
wrongSupport.fireplaces![0].supportY! += 0.1;
assertThrows(
  () => compileArchitecture(wrongSupport),
  /finished floor/,
  "fireplace support detached from floor",
);
const wrongSite = structuredClone(spec);
wrongSite.functional!.site.entranceSupport!.center[1] += 0.1;
assertThrows(
  () => compileArchitecture(wrongSite),
  /lowest authored tread/,
  "site support detached from lowest tread",
);
const wrongVolume=structuredClone(spec);wrongVolume.volumes[0].floorY-=.02;
assertThrows(()=>compileArchitecture(wrongVolume),/finished-floor authority/,"volume floor detached from finished floor");
const wrongPortal=structuredClone(spec);wrongPortal.volumes[0].openings.find((opening)=>opening.id==="portal/exterior")!.sillY+=.02;
assertThrows(()=>compileArchitecture(wrongPortal),/finished-floor authority/,"entrance sill detached from finished floor");

function assertThrows(run: () => unknown, pattern: RegExp, message: string) {
  try {
    run();
  } catch (error) {
    assert(pattern.test(String(error)),`${message}: wrong diagnostic ${String(error)}`);return;
  }
  throw new Error(`p_architecture_elevation_revision FAIL: ${message}`);
}

console.log(
  "p_architecture_elevation_revision OK: joined dormer, floor-bearing hearth, grade-bearing stair",
);
