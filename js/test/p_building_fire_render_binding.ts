import * as THREE from "../build/three.bundle.mjs";
import { BuildingFireRuntime } from "../src/render/building-fire-runtime.ts";
import { createBuildingFireRenderBinding, type BuildingFireRenderContract } from "../src/render/building-fire-render-binding.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_building_fire_render_binding FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let failure: unknown; try { operation(); } catch (error) { failure = error; }
  assert(failure instanceof Error && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not throw"}`);
}

function contract(): BuildingFireRenderContract {
  const socket = (id: string, kind: string, position: [number, number, number]) => ({ id, kind, position });
  const layer = (id: string, region: "inner" | "outer", ribbonCount: number, segments: number, heightM: number,
    widthM: number, phase01: number) => ({ id, region, socketId: "socket/flame", geometry: "ribbon-stack" as const,
      ribbonCount, segments, heightM, widthM, phase01, deformation: { frequencyHz: 2 + phase01, lateralAmplitudeM: .04,
        heightAmplitudeM: .06, noiseOctaves: 3 } });
  return {
    packageId: "fire/test/v1", revision: 1,
    shellInterface: { containment: { center: [0, .95, 0], halfExtents: [.65, .75, .58] },
      flue: { center: [0, 2.15, 0], halfExtents: [.3, .55, .3] }, sockets: [
        socket("socket/flame", "flame", [0, .52, 0]), socket("socket/ember", "ember", [0, .46, 0]),
        socket("socket/light", "light", [0, .8, -.25]), socket("socket/smoke", "smoke", [0, 1.3, 0]),
      ] },
    fuelAsset: { runtimeGlb: { path: "assets/fire/test.glb", sha256: `sha256:${"1".repeat(64)}`, assetId: "fire/test.glb" },
      coals: Array.from({ length: 8 }, (_, index) => ({ id: `coal/${String(index).padStart(2, "0")}`,
      socketId: "socket/ember", materialRole: "hearth-embers" as const,
      offset: [((index % 4) - 1.5) * .13, (index % 2) * .018, (Math.floor(index / 4) - .5) * .18] as [number, number, number],
      halfExtents: [.045 + index * .002, .022 + (index % 3) * .002, .035 + (index % 2) * .004] as [number, number, number],
      emission01: .35 + index * .05 })), emberBed: { socketId: "socket/ember", halfExtents: [.48, .025, .32] } },
    visuals: { flameLayers: [layer("flame/inner-a", "inner", 3, 9, .46, .14, .11),
      layer("flame/inner-b", "inner", 2, 8, .34, .11, .37), layer("flame/outer-a", "outer", 4, 11, .72, .28, .62),
      layer("flame/outer-b", "outer", 3, 10, .58, .22, .89)],
      embers: { socketId: "socket/ember", pulseFrequencyHz: .7, pulseAmplitude01: .3 },
      smoke: { enabled: true, socketId: "socket/smoke", particleCount: 24, lifespanSeconds: 3.2, riseMps: .28,
        maxOpacity: .12, flueTraversalClaim: false, absorbBeforeThroat: true } },
    light: { socketId: "socket/light", colorPolicy: "building-fire-runtime-warm-flicker-srgb",
      baseCandela: 7.4, flickerAmplitudeCandela: .4, distanceM: 2.2, decay: 2, castsShadow: true },
    simulation: { tickHz: 60, seed: 271828, parameters: { ignitionTicks: 60, extinguishTicks: 90,
      lightBaseCandela: 7.4, lightFlickerCandela: .4, lightDistanceM: 2.2, lightDecay: 2 } },
    budgets: { maxDrawCalls: 8, maxTriangles: 12_000, maxParticles: 64, maxOwnedLights: 1,
      maxOwnedMaterials: 4, timestampQueriesEnabled: false },
  };
}

const parent = new THREE.Group(), binding = createBuildingFireRenderBinding({ parent, contract: contract() });
assert(parent.children.length === 1 && parent.children[0] === binding.root, "binding did not publish exactly one owned root");
assert(binding.inventory.flameLayers === 4 && binding.inventory.flameRibbons === 12
  && binding.inventory.emberGlowCores === 8 && binding.inventory.emberGlowGeometry === "irregular-instanced-coals"
  && binding.inventory.smokeParticles === 24 && binding.inventory.ownedGeometries === 6
  && binding.inventory.ownedMaterials === 4 && binding.inventory.ownedLights === 1
  && binding.inventory.predictedDrawCalls === 6 && binding.inventory.triangles > 200 && binding.inventory.triangles < 12_000,
"construction inventory does not describe the contract-driven ribbon/ember/smoke package");
assert(binding.inventory.smokeMaximumWorldY !== null && binding.inventory.smokeMaximumWorldY < 1.6
  && binding.inventory.smokeFlueTraversalClaim === false, "smoke did not fade below the throat without a flue claim");
const flames = binding.root.children.filter((child) => child.name.startsWith("limina:flame/"));
assert(flames.length === 4 && flames.every((child) => child instanceof THREE.Mesh && child.geometry.type === "BufferGeometry"),
  "production flame layers are not real ribbon-stack meshes");
assert(!binding.root.children.some((child) => /cone/i.test((child as THREE.Mesh).geometry?.type ?? "")),
  "static cone geometry leaked into the fire binding");
const emberGlow = binding.root.getObjectByName("limina:fire-irregular-coal-glow-cores");
assert(emberGlow instanceof THREE.InstancedMesh && emberGlow.count === 8
  && emberGlow.geometry.type === "DodecahedronGeometry" && emberGlow.userData.liminaNoMoundOrBoxGlow === true,
  "dynamic ember glow is not one instanced irregular low-poly coal bed");
const coalMatrices = Array.from({ length: emberGlow.count }, (_, index) => { const matrix = new THREE.Matrix4();
  emberGlow.getMatrixAt(index, matrix); return matrix.elements.map((value) => value.toFixed(6)).join(","); });
assert(new Set(coalMatrices).size === emberGlow.count, "authored coal offsets/extents did not produce varied per-coal transforms");
assert(binding.light instanceof THREE.PointLight && binding.light.intensity === 0 && binding.light.distance === 2.2
  && binding.light.decay === 2 && binding.light.castShadow && binding.light.color.equals(new THREE.Color(0, 0, 0)),
  "bounded point light construction drifted");

const runtime = new BuildingFireRuntime({ seed: 271828, ignitionTicks: 60, extinguishTicks: 90,
  lightBaseCandela: 7.4, lightFlickerCandela: .4, lightDistanceM: 2.2, binding });
assert(binding.root.userData.liminaAuthoritativeEnvelope === 0 && binding.light.intensity === 0,
  "off-state runtime did not force the coal glow and light authority envelope to zero");
runtime.start(); const sample = runtime.advanceTicks(60);
const expectedSampleColor = new THREE.Color().setRGB(...sample.colorSrgb, THREE.SRGBColorSpace);
assert(binding.light.intensity === sample.intensityCandela && binding.light.distance === sample.distanceM
  && binding.light.decay === sample.decay && binding.light.color.equals(expectedSampleColor) && binding.light.visible,
  "authoritative runtime sample did not project exact light intensity, distance, decay, and sRGB color");
const firstColor = binding.light.color.clone(), laterSample = runtime.advanceTicks(1);
assert(!binding.light.color.equals(firstColor)
  && binding.light.color.equals(new THREE.Color().setRGB(...laterSample.colorSrgb, THREE.SRGBColorSpace)),
  "authoritative runtime color did not update with a later flicker sample");
binding.setVisible(false);
assert(!binding.root.visible && !binding.light.visible, "paired baseline visibility did not hide geometry and light together");
runtime.advanceTicks(12);
assert(!binding.light.visible, "hidden paired baseline leaked a later light update");
binding.setVisible(true);
assert(binding.root.visible && binding.light.visible && binding.light.intensity === runtime.lightSample().intensityCandela,
  "candidate visibility did not restore latest authoritative light state");

const ownedGeometries = new Set<THREE.BufferGeometry>(), ownedMaterials = new Set<THREE.Material>();
binding.root.traverse((object) => { if (!(object instanceof THREE.Mesh)) return; ownedGeometries.add(object.geometry);
  const values = Array.isArray(object.material) ? object.material : [object.material]; values.forEach((value) => ownedMaterials.add(value)); });
let geometryDisposals = 0, materialDisposals = 0, lightDisposals = 0;
ownedGeometries.forEach((value) => value.addEventListener("dispose", () => { geometryDisposals++; }));
ownedMaterials.forEach((value) => value.addEventListener("dispose", () => { materialDisposals++; }));
binding.light.addEventListener("dispose", () => { lightDisposals++; });
runtime.dispose(); runtime.dispose();
assert(parent.children.length === 0 && binding.disposed && geometryDisposals === ownedGeometries.size
  && materialDisposals === ownedMaterials.size && lightDisposals === 1, "owned fire resources did not dispose exactly once");
rejects(() => binding.setVisible(true), /disposed/, "disposed binding accepted visibility mutation");

const escaped = contract(); (escaped.visuals.flameLayers[2] as any).heightM = 1.5;
rejects(() => createBuildingFireRenderBinding({ parent: new THREE.Group(), contract: escaped }), /containment/,
  "flame geometry escaping containment was accepted");
const smokeClaim = contract(); (smokeClaim.visuals.smoke as any).flueTraversalClaim = true;
rejects(() => createBuildingFireRenderBinding({ parent: new THREE.Group(), contract: smokeClaim }), /flue traversal/,
  "smoke was allowed to claim unaudited flue traversal");
const timestamp = contract(); (timestamp.budgets as any).timestampQueriesEnabled = true;
rejects(() => createBuildingFireRenderBinding({ parent: new THREE.Group(), contract: timestamp }), /timestamp queries/,
  "timestamp-query fire binding was accepted");
const staleLight = contract(); (staleLight.light as any).meanCandela = staleLight.light.baseCandela;
delete (staleLight.light as any).baseCandela;
rejects(() => createBuildingFireRenderBinding({ parent: new THREE.Group(), contract: staleLight }), /baseCandela|policy|authority/,
  "superseded fire light schema was accepted");

console.log("p_building_fire_render_binding OK: contract-driven TSL ribbon layers, authoritative ember/smoke/light projection, paired visibility, containment, and exact CPU-only lifecycle are proven");
