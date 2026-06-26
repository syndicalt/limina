// Live world renderer — a bright low-poly THREE/WebGPU scene driven by the world
// view-model (buildWorldModel): SOLID meshes for entities currently in the world,
// translucent GHOST markers for held edits awaiting review. Reuses the Phase 9
// terrain + prop GEOMETRY (js/src/terrain/{mesh,props}.ts) so the ground + props
// are the same low-poly shapes the engine streams.
//
// NOTE: the in-tab render is UAT (no GPU in CI). The view-model that feeds it is
// verified headlessly (js/test/p_coordinator_demo.ts); this module only paints it.

import * as THREE from "../../js/build/three.bundle.mjs";
import { terrainTileGeometry } from "../../js/src/terrain/mesh.ts";
import { propGeometry } from "../../js/src/terrain/props.ts";
import { PropKind } from "../../js/src/terrain/scatter.ts";

const SAND = 0xe9d8a6;
const COTTAGE = 0x9c6b3f;
const ROOF = 0x7a4a2b;
const SKY_TOP = 0x8ecae6;
const SKY_BOTTOM = 0xcdeefb;

/** A flat low-poly terrain tile geometry (heights all 0) at a world centre. */
function flatTileGeometry(cx, cz, size) {
  const n = 8;
  const tile = {
    nrows: n,
    ncols: n,
    heights: new Float32Array(n * n),
    origin: [cx, 0, cz],
    scale: [size, 1, size],
  };
  const g = terrainTileGeometry(tile);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return geom;
}

/** A prop geometry (vertex-coloured) for a PropKind. */
function propBufferGeometry(kind) {
  const g = propGeometry(kind);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(g.colors, 3));
  geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return geom;
}

export class WorldRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.ready = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_BOTTOM);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
    this.camera.position.set(70, 60, 130);
    this.camera.lookAt(40, 0, 40);

    // Bright sky + sun.
    const hemi = new THREE.HemisphereLight(SKY_TOP, SAND, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4d6, 1.5);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);

    // A baseline sea-plane so the world never looks empty before terrain lands.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardNodeMaterial
        ? new THREE.MeshStandardNodeMaterial({ color: 0x7fc4d6, roughness: 0.85 })
        : new THREE.MeshStandardMaterial({ color: 0x7fc4d6, roughness: 0.85 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.4;
    this.scene.add(sea);

    this.solidGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.scene.add(this.solidGroup);
    this.scene.add(this.ghostGroup);

    this._mat = (color, opts = {}) => {
      const Std = THREE.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
      return new Std({ color, roughness: 0.7, metalness: 0.05, ...opts });
    };
    this._vcMat = (opts = {}) => {
      const Std = THREE.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
      return new Std({ vertexColors: true, roughness: 0.7, metalness: 0.05, ...opts });
    };
  }

  /** Initialise the WebGPU renderer (async; falls back to its WebGL backend). */
  async init() {
    const Renderer = THREE.WebGPURenderer;
    this.renderer = new Renderer({ canvas: this.canvas, antialias: true, alpha: false });
    if (this.renderer.init) await this.renderer.init();
    this.resize();
    this.ready = true;
    const loop = () => {
      if (!this.ready) return;
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    if (this.renderer) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  _clear(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
      else child.material?.dispose?.();
    }
  }

  /** Build a mesh for one renderable item (entity or ghost). */
  _meshFor(kind, position, opts = {}) {
    const [x, y, z] = position;
    const size = opts.size ?? 1;
    let mesh;
    if (kind === "ground") {
      mesh = new THREE.Mesh(flatTileGeometry(0, 0, opts.size ?? 48), this._mat(SAND, opts.ghost ? { transparent: true, opacity: 0.35 } : {}));
      mesh.position.set(x, 0, z);
      return mesh;
    }
    if (kind === "structure") {
      // A little cottage: a box body + a pyramid roof.
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.8, size), this._mat(COTTAGE, opts.ghost ? { transparent: true, opacity: 0.4 } : {}));
      body.position.y = size * 0.4;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(size * 0.85, size * 0.7, 4), this._mat(ROOF, opts.ghost ? { transparent: true, opacity: 0.4 } : {}));
      roof.position.y = size * 0.8 + size * 0.35;
      roof.rotation.y = Math.PI / 4;
      g.add(body, roof);
      g.position.set(x, y - size * 0.4, z);
      return g;
    }
    if (kind === "prop") {
      // Palm-ish green props become trees; brown driftwood becomes a rock.
      const isWood = (opts.color ?? 0) === 0xa0522d;
      const pk = isWood ? PropKind.Rock : PropKind.Tree;
      mesh = new THREE.Mesh(propBufferGeometry(pk), this._vcMat(opts.ghost ? { transparent: true, opacity: 0.45 } : {}));
      const s = size * 1.6;
      mesh.scale.set(s, s, s);
      mesh.position.set(x, y - size * 0.5, z);
      return mesh;
    }
    // generic object / unknown edit: a small box marker.
    mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), this._mat(opts.color ?? 0x6c8ebf, opts.ghost ? { transparent: true, opacity: 0.4 } : {}));
    mesh.position.set(x, y, z);
    return mesh;
  }

  /** Paint the world from a view-model { entities, ghosts }. */
  render(model) {
    this._clear(this.solidGroup);
    this._clear(this.ghostGroup);
    for (const e of model.entities) {
      const mesh = this._meshFor(e.kind, e.position, { size: e.scale?.[0] && e.scale[0] > 1 ? e.scale[0] : (e.kind === "structure" ? 3 : 1) });
      this.solidGroup.add(mesh);
    }
    for (const gst of model.ghosts) {
      const mesh = this._meshFor(gst.kind, gst.position, { size: gst.size ?? 1, color: gst.color, ghost: true });
      // a soft pulse offset so ghosts read as "proposed"
      mesh.position.y += 0.0;
      this.ghostGroup.add(mesh);
    }
  }
}
