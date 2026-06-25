// limina UI — anchoring (A2 world billboard + A3 screen overlay). Panel owns the
// composited quad; this module places + orients it.
//
//  WORLD  — pin the quad to an entity/world point + offset, and (billboard) make
//           it face the camera every frame via mesh.lookAt(cameraWorldPos): the
//           quad's +Z then points exactly at the camera (forward·dirToCam == 1).
//
//  SCREEN — pin the quad to a screen corner INDEPENDENT of the camera. The quad
//           is NOT a world object: each frame it is re-derived RELATIVE to the
//           camera (position = camPos + right*ox + up*oy + forward*d, orientation
//           = the camera's), so its projection is constant NDC regardless of how
//           the camera moves/orbits (the camera transform cancels in
//           projection*view*world). depthTest off + a high renderOrder draw it
//           OVER the scene. Sizing is DPI/viewport-aware (1 composited texel ->
//           1 screen pixel at any viewport size), recomputed from fov + height.

import * as THREE from "../../build/three.bundle.mjs";
import type { Panel, PanelMesh } from "./surface.ts";

export type Vec3 = [number, number, number];

/** Object3D members we drive (the bundle ships no types; PanelMesh is minimal). */
interface Object3DLike {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  quaternion: { copy(q: unknown): unknown; x: number; y: number; z: number; w: number };
  scale: { set(x: number, y: number, z: number): void; setScalar(s: number): void };
  renderOrder: number;
  visible: boolean;
  lookAt(x: number, y: number, z: number): void;
  getWorldDirection(target: unknown): { x: number; y: number; z: number };
  updateMatrixWorld(force?: boolean): void;
  matrixWorld: { elements: number[] };
}

/** Camera members we read for the screen overlay math. */
export interface AnchorCamera {
  position: { x: number; y: number; z: number };
  fov: number;
  aspect: number;
  matrixWorld: { elements: number[] };
  getWorldQuaternion(q: unknown): unknown;
  updateMatrixWorld(force?: boolean): void;
}

/** Read a camera's world position from its (updated) world matrix. */
function cameraWorldPos(camera: AnchorCamera): { x: number; y: number; z: number } {
  camera.updateMatrixWorld(true);
  const e = camera.matrixWorld.elements;
  return { x: e[12], y: e[13], z: e[14] };
}

// ---- world anchor ----------------------------------------------------------

export interface WorldAnchorOptions {
  /** entity/world position: a fixed point or a per-frame getter (entity follow). */
  position: Vec3 | (() => Vec3);
  /** world-space offset added to the anchored position (e.g. float above a head). */
  offset?: Vec3;
  /** face the camera each frame (default true); false keeps a fixed orientation. */
  billboard?: boolean;
  /** draw order; higher draws later/over. A speech bubble bumps this above its
   *  nametag label so the bubble text wins when they overlap (default 0). */
  renderOrder?: number;
  /** when false, the quad ignores the depth buffer and always draws (over scene
   *  geometry + lower-order billboards) — the bubble stays readable even when a
   *  closer label/tree would otherwise occlude it. Default leaves it untouched. */
  depthTest?: boolean;
}

/** Pins a Panel to a world position and (by default) billboards it at the camera. */
export class WorldAnchor {
  private readonly mesh: Object3DLike;
  private readonly position: Vec3 | (() => Vec3);
  private readonly offset: Vec3;
  readonly billboard: boolean;

  constructor(panel: Panel | PanelMesh, opts: WorldAnchorOptions) {
    const mesh = (panel as Panel).mesh ?? (panel as PanelMesh);
    this.mesh = mesh as unknown as Object3DLike;
    this.position = opts.position;
    this.offset = opts.offset ?? [0, 0, 0];
    this.billboard = opts.billboard ?? true;
    if (opts.renderOrder !== undefined) this.mesh.renderOrder = opts.renderOrder;
    if (opts.depthTest !== undefined) (mesh as PanelMesh).material.depthTest = opts.depthTest;
  }

  /** Place + orient the quad for this frame. */
  update(camera: AnchorCamera): void {
    const p = typeof this.position === "function" ? this.position() : this.position;
    this.mesh.position.set(p[0] + this.offset[0], p[1] + this.offset[1], p[2] + this.offset[2]);
    if (this.billboard) {
      const c = cameraWorldPos(camera);
      this.mesh.lookAt(c.x, c.y, c.z);
    }
    this.mesh.updateMatrixWorld(true);
  }

  /** The quad's current world-space forward (+Z) axis — used to verify facing. */
  forward(): { x: number; y: number; z: number } {
    return this.mesh.getWorldDirection(new THREE.Vector3());
  }

  /** The quad's current world position. */
  worldPosition(): Vec3 {
    const p = this.mesh.position;
    return [p.x, p.y, p.z];
  }
}

// ---- screen anchor ---------------------------------------------------------

export type ScreenCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "bottom-center"
  | "center";

export interface ScreenAnchorOptions {
  corner?: ScreenCorner;
  /** corner inset in screen px [x, y] (default [16, 16]). */
  marginPx?: [number, number];
  /** depth in front of the camera (world units, default 1). */
  distance?: number;
  /** draw order; higher draws later/over (default 1000). */
  renderOrder?: number;
}

/** Pins a Panel to a screen corner, camera-independent + over the scene. */
export class ScreenAnchor {
  private readonly panel: Panel;
  private readonly mesh: Object3DLike;
  readonly corner: ScreenCorner;
  private readonly marginPx: [number, number];
  private readonly distance: number;

  constructor(panel: Panel, opts: ScreenAnchorOptions = {}) {
    this.panel = panel;
    this.mesh = panel.mesh as unknown as Object3DLike;
    this.corner = opts.corner ?? "top-right";
    this.marginPx = opts.marginPx ?? [16, 16];
    this.distance = opts.distance ?? 1;
    // Over-scene: ignore the depth buffer and draw last.
    panel.material.depthTest = false;
    panel.material.depthWrite = false;
    panel.material.transparent = true;
    this.mesh.renderOrder = opts.renderOrder ?? 1000;
  }

  /** Screen-pixel center this anchor targets for the given viewport (1:1 texels). */
  targetPixel(viewportW: number, viewportH: number): { x: number; y: number } {
    const halfW = this.panel.width / 2;
    const halfH = this.panel.height / 2;
    const [mx, my] = this.marginPx;
    let x: number;
    let y: number;
    if (this.corner === "center") {
      x = viewportW / 2;
      y = viewportH / 2;
    } else {
      if (this.corner === "top-center" || this.corner === "bottom-center") x = viewportW / 2;
      else if (this.corner.endsWith("left")) x = mx + halfW;
      else x = viewportW - mx - halfW;
      if (this.corner.startsWith("top")) y = my + halfH;
      else y = viewportH - my - halfH;
    }
    return { x, y };
  }

  /** Re-derive the quad's world transform from the camera so it lands at its
   *  corner, sized 1 texel == 1 screen pixel, facing the viewer. Call per frame
   *  (and on resize). Camera-independent: the result projects to a constant
   *  screen pixel whatever the camera's orientation. */
  update(camera: AnchorCamera, viewportW: number, viewportH: number): void {
    camera.updateMatrixWorld(true);
    const e = camera.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2]; // camera right (+X)
    const ux = e[4], uy = e[5], uz = e[6]; // camera up (+Y)
    const fx = -e[8], fy = -e[9], fz = -e[10]; // camera forward (-Z)
    const cx = e[12], cy = e[13], cz = e[14]; // camera world position

    const fovR = (camera.fov * Math.PI) / 180;
    const halfH = this.distance * Math.tan(fovR / 2);
    const halfW = halfH * camera.aspect;

    const target = this.targetPixel(viewportW, viewportH);
    const ndcX = (2 * target.x) / viewportW - 1;
    const ndcY = 1 - (2 * target.y) / viewportH;
    const ox = ndcX * halfW;
    const oy = ndcY * halfH;

    this.mesh.position.set(
      cx + rx * ox + ux * oy + fx * this.distance,
      cy + ry * ox + uy * oy + fy * this.distance,
      cz + rz * ox + uz * oy + fz * this.distance,
    );
    const q = new THREE.Quaternion();
    camera.getWorldQuaternion(q);
    this.mesh.quaternion.copy(q);
    // 1 composited texel -> 1 screen pixel, independent of viewport/DPI.
    this.mesh.scale.setScalar((2 * halfH) / (viewportH * this.panel.pixelScale));
    this.mesh.updateMatrixWorld(true);
  }

  /** The quad's current world position (project it with the camera to verify). */
  worldPosition(): Vec3 {
    const p = this.mesh.position;
    return [p.x, p.y, p.z];
  }
}
