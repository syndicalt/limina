import * as THREE from "../build/three.bundle.mjs";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { grassFieldInstanceSpacing } from "../src/render/grass-field-package.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_grass_silhouette_contract FAIL: ${message}`);
}

type Quality = "performance" | "balanced" | "cinematic";
type Lod = 0 | 1;

const qualities = ["performance", "balanced", "cinematic"] as const;
const lods = [0, 1] as const;
const coverageFloor: Readonly<Record<Quality, readonly [number, number]>> = Object.freeze({
  // Far floors are density-normalized for the deliberately clustered full-window LOD. They are
  // not near-field ratios: residency is allowed to reduce actual blade density instead of leaving
  // the outer camera window empty, but the remaining modeled blades must retain real leaf area.
  // Reviewed against package 3.3.0's narrower natural-blade direction. These remain below the
  // measured values but above any isolated-card/wispy fallback; they complement rather than
  // replace the density, component-count, fold-normal, taper, and cluster-continuity checks.
  performance: Object.freeze([0.28, 0.013]),
  balanced: Object.freeze([0.54, 0.032]),
  cinematic: Object.freeze([1.02, 0.15]),
});

interface GeometryEvidence {
  readonly longitudinalSegments: number;
  readonly projectedCoverage: number;
  readonly horizontalSpanToHeight: number;
  readonly clusterDiameterToPitch: number;
}

/** Measure the actual connected folded-blade triangles used by the package's mid representation.
 * The retired card opacity mask cannot satisfy this contract because it had only eight quads. */
function inspectMidClusterProjectedArea(quality: Quality): number {
  const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile(quality);
  const band = profile.additionalContinuousBands?.find((entry) => entry.id === "mid-cluster");
  assert(band !== undefined, `${quality} omitted its mid-cluster profile`);
  const geometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({
    quality, lod: band.lod, maxBlades: band.maxResidentBlades, presentationBand: band.id,
  });
  try {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const descriptor = geometry.userData.liminaMidClusterGeometry as any, index = geometry.index;
    assert(position?.count === 64 && index?.count === 96
      && descriptor?.schema === "limina.grass-mid-physical-cluster/v1"
      && descriptor.blades === 16 && descriptor.foldedLightingSurface === true,
    `${quality} mid-cluster is not sixteen auditable folded physical blades`);
    let projectedArea = 0;
    for (let view = 0; view < 64; view++) projectedArea += projectedTriangleArea(position, index, view * Math.PI * 2 / 64);
    projectedArea /= 64;
    assert(Math.abs(projectedArea - band.projectedAreaPerInstanceM2) <= 0.0002,
      `${quality} measured mid geometry ${projectedArea.toFixed(4)}m2 diverges from declared ${band.projectedAreaPerInstanceM2.toFixed(4)}m2`);
    assert(Math.abs(band.targetProjectedCoverage
      - band.bladesPerSquareMeter * projectedArea / descriptor.blades) <= 0.0002,
    `${quality} mid target coverage is not derived from physical blade geometry`);
    return projectedArea;
  } finally { geometry.dispose(); }
}

function projectedTriangleArea(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute,
  azimuth: number,
): number {
  // Project onto an upright plane. Its horizontal axis is perpendicular to the horizontal view
  // direction while world Y remains vertical. Absolute triangle areas make winding irrelevant.
  const rightX = -Math.sin(azimuth), rightZ = Math.cos(azimuth);
  let area = 0;
  for (let offset = 0; offset < index.count; offset += 3) {
    const ia = index.getX(offset), ib = index.getX(offset + 1), ic = index.getX(offset + 2);
    const ax = position.getX(ia) * rightX + position.getZ(ia) * rightZ, ay = position.getY(ia);
    const bx = position.getX(ib) * rightX + position.getZ(ib) * rightZ, by = position.getY(ib);
    const cx = position.getX(ic) * rightX + position.getZ(ic) * rightZ, cy = position.getY(ic);
    area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5;
  }
  return area;
}

function inspectGeometry(quality: Quality, lod: Lod): GeometryEvidence {
  const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile(quality);
  const geometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({
    quality, lod, maxBlades: profile.maxResidentBlades,
  });
  try {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const index = geometry.index;
    assert(position !== undefined && position.itemSize === 3 && position.count >= 4,
      `${quality} LOD ${lod} omitted modeled blade positions`);
    assert(index !== null && index.count >= 3 && index.count % 3 === 0,
      `${quality} LOD ${lod} is not connected indexed triangle geometry`);
    assert(normal !== undefined && normal.itemSize === 3 && normal.count === position.count,
      `${quality} LOD ${lod} omitted one derived normal per vertex`);
    assert(uv !== undefined && uv.itemSize === 2 && uv.count === position.count,
      `${quality} LOD ${lod} omitted one UV per vertex`);
    assert(geometry.userData.liminaTemperateMeadowBlades === profile.bladesPerInstance[lod],
      `${quality} LOD ${lod} geometry and declared actual-blade accounting diverged`);

    const adjacency: number[][] = Array.from({ length: position.count }, () => []);
    const referenced = new Uint8Array(position.count);
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = index.getX(offset), b = index.getX(offset + 1), c = index.getX(offset + 2);
      assert(Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(c)
        && a >= 0 && b >= 0 && c >= 0 && a < position.count && b < position.count && c < position.count,
      `${quality} LOD ${lod} contains an out-of-range triangle index`);
      referenced[a] = referenced[b] = referenced[c] = 1;
      adjacency[a].push(b, c); adjacency[b].push(a, c); adjacency[c].push(a, b);

      const abx = position.getX(b) - position.getX(a);
      const aby = position.getY(b) - position.getY(a);
      const abz = position.getZ(b) - position.getZ(a);
      const acx = position.getX(c) - position.getX(a);
      const acy = position.getY(c) - position.getY(a);
      const acz = position.getZ(c) - position.getZ(a);
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      assert(crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-14,
        `${quality} LOD ${lod} contains a degenerate triangle at index offset ${offset}`);
    }
    assert(referenced.every((value) => value === 1),
      `${quality} LOD ${lod} contains vertices outside the indexed blade surface`);
    const visited = new Uint8Array(position.count), components: number[][] = [];
    for (let seed = 0; seed < position.count; seed++) {
      if (visited[seed] !== 0) continue;
      const component: number[] = [], pending = [seed]; visited[seed] = 1;
      while (pending.length > 0) {
        const vertex = pending.pop()!; component.push(vertex);
        for (const neighbor of adjacency[vertex]) if (visited[neighbor] === 0) {
          visited[neighbor] = 1; pending.push(neighbor);
        }
      }
      components.push(component);
    }
    assert(components.length === profile.bladesPerInstance[lod],
      `${quality} LOD ${lod} publishes ${components.length} connected blade components but declares ${profile.bladesPerInstance[lod]}`);
    if (lod === 0) assert(components.length === 1 && profile.bladesPerInstance[lod] === 1,
      `${quality} near LOD stopped representing one independently instanced connected blade`);
    else assert(profile.bladesPerInstance[lod] >= 8,
      `${quality} far LOD collapsed from bounded meadow clusters to isolated wisps`);

    let minY = Infinity, maxY = -Infinity, horizontalSpan = 0;
    for (let vertex = 0; vertex < position.count; vertex++) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
      const nx = normal.getX(vertex), ny = normal.getY(vertex), nz = normal.getZ(vertex);
      const u = uv.getX(vertex), v = uv.getY(vertex);
      assert(Number.isFinite(x + y + z + nx + ny + nz + u + v),
        `${quality} LOD ${lod} contains non-finite position, normal, or UV data`);
      assert(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-4,
        `${quality} LOD ${lod} contains a non-unit derived normal`);
      assert(u >= 0 && u <= 1 && v >= 0 && v <= 1,
        `${quality} LOD ${lod} contains UV coordinates outside the blade atlas domain`);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let other = vertex + 1; other < position.count; other++) {
        horizontalSpan = Math.max(horizontalSpan,
          Math.hypot(position.getX(other) - x, position.getZ(other) - z));
      }
    }
    const height = maxY - minY;
    const horizontalSpanToHeight = horizontalSpan / height;
    let clusterDiameterToPitch = Number.NaN;
    // User-reviewed direction favors narrower natural blades. Folded-surface topology and the
    // density-normalized projected-coverage floor below still reject the old sparse/wispy cheat,
    // so blade width need not carry that burden by itself.
    if (lod === 0) assert(height > 0 && horizontalSpanToHeight >= 0.14 && horizontalSpanToHeight <= 0.42,
      `${quality} near LOD blade span/height ratio ${horizontalSpanToHeight.toFixed(3)} is outside 0.14..0.42`);
    else {
      const instancePitch = grassFieldInstanceSpacing(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, quality, lod);
      clusterDiameterToPitch = horizontalSpan / instancePitch;
      assert(horizontalSpan >= instancePitch * 0.75,
        `${quality} far LOD cluster diameter ${horizontalSpan.toFixed(3)} leaves isolated tuft islands at ${instancePitch.toFixed(3)}m pitch`);
    }

    const rowSpan = (vertices: readonly number[]): number => {
      let span = 0;
      for (let a = 0; a < vertices.length; a++) for (let b = a + 1; b < vertices.length; b++) {
        span = Math.max(span, Math.hypot(
          position.getX(vertices[a]) - position.getX(vertices[b]),
          position.getZ(vertices[a]) - position.getZ(vertices[b]),
        ));
      }
      return span;
    };
    let minimumLongitudinalSegments = Infinity;
    for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
      const component = components[componentIndex];
      const rows = new Map<string, number[]>();
      for (const vertex of component) {
        const key = position.getY(vertex).toFixed(6);
        const row = rows.get(key) ?? []; row.push(vertex); rows.set(key, row);
      }
      const surfaceRows = [...rows.entries()].filter(([, vertices]) => vertices.length >= 3)
        .sort(([a], [b]) => Number(a) - Number(b));
      minimumLongitudinalSegments = Math.min(minimumLongitudinalSegments, surfaceRows.length);
      assert(surfaceRows.length >= 3,
        `${quality} LOD ${lod} blade component ${componentIndex} has fewer than three longitudinal segments`);
      const rootSpan = rowSpan(surfaceRows[0][1]);
      const upperSpan = rowSpan(surfaceRows[surfaceRows.length - 1][1]);
      assert(rootSpan > 0 && upperSpan < rootSpan * 0.82,
        `${quality} LOD ${lod} blade component ${componentIndex} does not taper materially from root to tip`);

      let mostDifferentNormalDot = 1;
      for (let a = 0; a < component.length; a++) for (let b = a + 1; b < component.length; b++) {
        const va = component[a], vb = component[b];
        mostDifferentNormalDot = Math.min(mostDifferentNormalDot,
          normal.getX(va) * normal.getX(vb) + normal.getY(va) * normal.getY(vb) + normal.getZ(va) * normal.getZ(vb));
      }
      assert(mostDifferentNormalDot < 0.95,
        `${quality} LOD ${lod} blade component ${componentIndex} collapsed to one flat normal instead of a folded lighting surface`);
    }

    const azimuthCount = 32;
    let projectedAreaSum = 0;
    for (let view = 0; view < azimuthCount; view++) {
      projectedAreaSum += projectedTriangleArea(position, index, view * Math.PI * 2 / azimuthCount);
    }
    // This is a deliberately mechanical anti-regression signal, not a visual verdict. Convert one
    // instance's average projected triangle area into area per m2 using honest modeled-blade counts.
    const projectedCoverage = projectedAreaSum / azimuthCount
      * profile.bladesPerSquareMeter[lod] / profile.bladesPerInstance[lod];
    assert(projectedCoverage >= coverageFloor[quality][lod],
      `${quality} LOD ${lod} projected triangle coverage ${projectedCoverage.toFixed(3)} is below ${coverageFloor[quality][lod].toFixed(2)}`);

    return { longitudinalSegments: minimumLongitudinalSegments, projectedCoverage,
      horizontalSpanToHeight, clusterDiameterToPitch };
  } finally {
    geometry.dispose();
  }
}

assert(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.version === "4.0.1",
  "silhouette contract must be reviewed when the active meadow package version changes");

const evidence = new Map<Quality, readonly [GeometryEvidence, GeometryEvidence]>();
const midEvidence = new Map<Quality, number>();
for (const quality of qualities) {
  const near = inspectGeometry(quality, lods[0]);
  const far = inspectGeometry(quality, lods[1]);
  evidence.set(quality, [near, far]);
  midEvidence.set(quality, inspectMidClusterProjectedArea(quality));
}

console.log(`p_grass_silhouette_contract OK: ${qualities.map((quality) => {
  const [near, far] = evidence.get(quality)!;
  return `${quality} near=${near.projectedCoverage.toFixed(3)} midArea=${midEvidence.get(quality)!.toFixed(3)}m2 far=${far.projectedCoverage.toFixed(3)} nearAspect=${near.horizontalSpanToHeight.toFixed(3)} farClusterPitch=${far.clusterDiameterToPitch.toFixed(3)} segments=${near.longitudinalSegments}/${far.longitudinalSegments}`;
}).join("; ")}`);
