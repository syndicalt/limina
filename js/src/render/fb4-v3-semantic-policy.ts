import type {
  BuildingSemanticEvidencePolicy,
  BuildingSemanticGlbTarget,
} from "./building-semantic-evidence.ts";

/**
 * Exact semantic-evidence policy for the immutable FB-4 V3 production family.
 *
 * This builder consumes the compiler sidecar supplied by the caller. It performs
 * no filesystem I/O and owns no candidate bytes, so tests and append-only review
 * builders use the same production policy without importing one another.
 */
export function createFb4V3SemanticPolicy(ir: any): BuildingSemanticEvidencePolicy {
  const one = (values: readonly any[] | undefined, id: string, label: string) => {
    const matches = values?.filter((entry) => entry?.id === id) ?? [];
    if (matches.length !== 1) throw new Error(`FB-4 semantic policy requires exactly one ${label} '${id}'`);
    return matches[0];
  };
  const group = (id: string, nodeIds: readonly string[], architectureOwnerId: string, architectureRegionId?: string): BuildingSemanticGlbTarget => ({
    kind: "glb-semantic-group",
    id,
    nodeIds,
    architectureOwnerId,
    ...(architectureRegionId === undefined ? {} : { architectureRegionId }),
  });
  const windowTargets = (id: string) => {
    const value = one(ir?.windows, id, "compiled window");
    if (typeof value.glazing?.id !== "string" || value.glazing.id.length === 0 || !Array.isArray(value.frame) || value.frame.length !== 4 || value.frame.some((entry: any) => typeof entry?.id !== "string" || entry.id.length === 0)) throw new Error(`FB-4 semantic policy window '${id}' lacks complete compiler-owned glazing/frame authority`);
    return {
      glass: group(`${id}/evidence-glass`, [value.glazing.id], id),
      frame: value.frame.map((entry: any, index: number) => group(`${id}/evidence-frame-${index}`, [entry.id], id)),
    };
  };
  const west = windowTargets("window/space/bedroom-a/0");
  const service = windowTargets("window/space/service-pantry/gable-0");
  const upper = windowTargets("window/space/bedroom-a/1");
  if (!Array.isArray(ir?.entranceCanopies) || ir.entranceCanopies.length !== 1) throw new Error("FB-4 semantic policy requires exactly one compiler-owned entrance canopy");
  const canopy = ir.entranceCanopies[0];
  if (typeof canopy?.id !== "string" || typeof canopy.roof?.id !== "string" || typeof canopy.header?.id !== "string" || !Array.isArray(canopy.kneeBraces) || canopy.kneeBraces.length !== 2 || !Array.isArray(canopy.posts) || canopy.posts.length !== 2) throw new Error("FB-4 semantic policy canopy authority is incomplete");
  const fireplace = one(ir?.fireplaces, "fireplace/hall", "compiled fireplace"),
    penetration = one(ir?.roofPenetrations, fireplace.penetrationId, "compiled fireplace roof penetration");
  if (!Array.isArray(fireplace.flueTransition) || fireplace.flueTransition.length !== 4 || !Array.isArray(penetration.shaft) || penetration.shaft.length !== 4)
    throw new Error("FB-4 semantic policy requires the complete hearth-to-shaft masonry transition");

  const policy: BuildingSemanticEvidencePolicy = {
    schema: "limina.building-semantic-evidence-policy/v2",
    viewport: [1920, 1080],
    safeFrameNdc: .94,
    minimumVisibleAnchors: 1,
    minimumVisibleFraction: .12,
    minimumProjectedWidthNdc: .002,
    minimumProjectedHeightNdc: .002,
    maximumTrianglesPerTarget: 96,
    rayEpsilonM: .003,
    minimumFacadeAlignmentDot: .75,
    claims: [
      {
        id: "gable-upper-window", viewId: "semantic/west-gable-upper-window", expectedFacade: "left-gable", viewedFacade: "left-gable", exteriorNormal: [-1, 0, 0],
        camera: { position: [-15, 5, -1.7], target: [-4.8, 4.835, -1.7], fovYDegrees: 42, nearM: .05, farM: 40 },
        targets: { glass: [west.glass], frame: west.frame },
      },
      {
        id: "entry-canopy", viewId: "semantic/entry-canopy-service-window", expectedFacade: "entry", viewedFacade: "entry", exteriorNormal: [0, 0, -1],
        camera: { position: [.58, 1.3, -13], target: [-.5, 1.5, -5.8], fovYDegrees: 58, nearM: .05, farM: 40 },
        targets: {
          roof: [group("canopy/evidence-roof", [canopy.roof.id], canopy.id)],
          header: [group("canopy/evidence-header", [canopy.header.id], canopy.id)],
          "knee-brace": canopy.kneeBraces.map((entry: any, index: number) => group(`canopy/evidence-knee-brace-${index}`, [entry.id], canopy.id)),
          post: [group("canopy/evidence-post-assembly", canopy.posts.map((entry: any) => entry.id), canopy.id)],
          "adjacent-window-glass": [service.glass],
          "adjacent-window-frame": service.frame,
        },
      },
      {
        id: "passage-fireplace", viewId: "semantic/hall-passage-fireplace", expectedFacade: "interior", viewedFacade: "interior",
        camera: { position: [-2.8, 1.6, -2.8], target: [-1.2, 1.1, 1.3], fovYDegrees: 80, nearM: .05, farM: 30 },
        targets: {
          "passage-aperture": [{ kind: "functional-portal-witness", id: "passage/evidence-hall-kitchen", portalId: "portal/hall-kitchen" }],
          "fireplace-hearth": [group("fireplace/evidence-hearth", ["fireplace/fireplace/hall/base"], "fireplace/hall")],
          "fireplace-firebox": [group("fireplace/evidence-firebox", ["fireplace/fireplace/hall/fireback"], "fireplace/hall")],
          "fireplace-mantle": [group("fireplace/evidence-mantle", ["fireplace/fireplace/hall/lintel"], "fireplace/hall")],
          "fireplace-surround": [group("fireplace/evidence-surround", ["fireplace/fireplace/hall/hood", "fireplace/fireplace/hall/jamb-left", "fireplace/fireplace/hall/jamb-right"], "fireplace/hall")],
          "fireplace-flue-transition": [
            group("fireplace/evidence-flue-transition", fireplace.flueTransition.map((entry: any) => entry.id), "fireplace/hall"),
          ],
        },
      },
      {
        id: "stair-circulation", viewId: "semantic/complete-stair-circulation", expectedFacade: "interior", viewedFacade: "interior",
        camera: { position: [.4, 2.15, -.15], target: [3.63, 1.65, .8], fovYDegrees: 120, nearM: .05, farM: 30 },
        targets: {
          "bottom-landing": [group("stairs/evidence-bottom-landing", ["stairs/stairs/primary/landing-bottom"], "stairs/primary")],
          "stair-low-extreme": [group("stairs/evidence-low-extreme", ["stairs/stairs/primary/flight-0/tread-0"], "stairs/primary")],
          "stair-turn-landing": [group("stairs/evidence-turn-landing", ["stairs/stairs/primary/landing-intermediate-0"], "stairs/primary")],
          "stair-high-extreme": [group("stairs/evidence-high-extreme", ["stair-detail/stairs/primary/flight-1/handrail-left", "stair-detail/stairs/primary/flight-1/handrail-right"], "stairs/primary")],
          "top-landing": [{ kind: "stair-top-arrival-witness", id: "stairs/evidence-top-arrival", stairId: "stairs/primary" }],
          "headroom-clearance": [{ kind: "stair-headroom-witness", id: "stairs/evidence-headroom", stairId: "stairs/primary" }],
        },
      },
      {
        id: "upper-circulation", viewId: "semantic/upper-landing-access-window", expectedFacade: "interior", viewedFacade: "interior",
        // This wide CPU-only diagnostic proves a near landing identity and distant
        // access/window targets together. It is not a human-review camera.
        camera: { position: [4.5, 5.2, -1.7], target: [0, 3, -2.2], fovYDegrees: 120, nearM: .05, farM: 30 },
        openDoorIds: ["door/landing-front"],
        targets: {
          "upper-landing": [{ kind: "functional-room-floor-witness", id: "upper/evidence-landing", roomId: "room/space/upper-landing" }],
          "access-frame": [group("upper/evidence-front-access", ["door/landing-front/frame-left", "door/landing-front/frame-right", "door/landing-front/frame-top"], "door/landing-front")],
          "upper-window-glass": [upper.glass],
          "upper-window-frame": upper.frame,
        },
      },
    ],
  };
  return Object.freeze(policy);
}
