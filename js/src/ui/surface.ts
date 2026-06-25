// limina UI — Panel / TextSurface: a composited RGBA box wrapped in a correctly
// configured THREE.DataTexture on a transparent PlaneGeometry quad.
//
// The DataTexture is the ONLY texture path that samples on the embedder's WebGPU
// backend: it has no GPUQueue.copyExternalImageToTexture, so ImageBitmap-backed
// textures upload BLACK; a texture flagged `isDataTexture` with raw RGBA pixels
// instead uploads via queue.writeTexture (see crates/limina-render js bootstrap
// + three.ts rehomeTextureToData). DataTexture already sets isDataTexture; we
// pick the rest of the config (format/type/flipY/colorSpace/filter/needsUpdate)
// so it samples upright, in the authored colors, and crisp — not black.
//
// The composited texture is cached: re-composite only when text/title/style
// changes (Panel.setText / setStyle). World placement (billboard for A2, screen
// quad for A3) is the caller's job — Panel owns the surface, not the anchoring.

import * as THREE from "../../build/three.bundle.mjs";
import { composite, type Composited, type TextStyle } from "./compositor.ts";

/** World units per composited texel — controls the quad's world size. */
const DEFAULT_PIXEL_SCALE = 0.01;

export interface PanelOptions {
  style: TextStyle;
  text: string;
  title?: string;
  /** world units per composited pixel (quad size); default 0.01 */
  pixelScale?: number;
}

// Minimal typed views over the three.js objects (the bundle ships no types).
interface DataTextureHandle {
  image: { data: Uint8Array; width: number; height: number };
  format: number;
  type: number;
  flipY: boolean;
  colorSpace: string;
  minFilter: number;
  magFilter: number;
  generateMipmaps: boolean;
  /** write-only in three (bumps `version`); set true to upload via writeTexture */
  needsUpdate: boolean;
  /** upload generation; bumped each time needsUpdate is set true */
  version: number;
  isDataTexture: boolean;
  dispose(): void;
}
interface MaterialHandle {
  map: DataTextureHandle | null;
  transparent: boolean;
  toneMapped: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  /** 0..1 quad-wide alpha multiplier; the lifecycle fade ramps this. */
  opacity: number;
  side: number;
  dispose(): void;
}
interface GeometryHandle {
  dispose(): void;
}
/** The scene-addable quad: an Object3D the caller positions/orients. */
export interface PanelMesh {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  visible: boolean;
  /** draw order; higher draws later/over (THREE default 0). Bubbles bump this
   *  above their nametag label so the speech text is never occluded. */
  renderOrder: number;
  geometry: GeometryHandle;
  material: MaterialHandle;
  /** recompute the world matrix after a position nudge (screen-space layout). */
  updateMatrixWorld(force?: boolean): void;
}

/** Build the DataTexture whose config makes the RGBA buffer SAMPLE (not black):
 *  RGBA8, flipY so the top-row-first buffer renders upright, sRGB so authored
 *  colors are correct, linear filtering, mipmaps off, needsUpdate to upload. */
function makeTexture(c: Composited): DataTextureHandle {
  const tex = new THREE.DataTexture(c.data, c.width, c.height, THREE.RGBAFormat, THREE.UnsignedByteType) as DataTextureHandle;
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A cached styled-text surface: composites once, re-composites only when its
 * content/style changes. `mesh` is added to a scene by the caller; `texture` is
 * the live DataTexture; `composited` is the current RGBA buffer.
 */
export class Panel {
  private style: TextStyle;
  private text: string;
  private title: string | undefined;
  private readonly _pixelScale: number;
  private key: string;
  private _composited: Composited;
  private _texture: DataTextureHandle;
  private readonly _material: MaterialHandle;
  private _geometry: GeometryHandle;
  private readonly _mesh: PanelMesh;

  constructor(opts: PanelOptions) {
    this.style = opts.style;
    this.text = opts.text;
    this.title = opts.title;
    this._pixelScale = opts.pixelScale ?? DEFAULT_PIXEL_SCALE;
    this._composited = composite(this.style, this.text, this.title);
    this.key = Panel.makeKey(this.style, this.text, this.title);
    this._texture = makeTexture(this._composited);
    this._material = new THREE.MeshBasicNodeMaterial({
      map: this._texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }) as MaterialHandle;
    // UI is unlit and must keep its authored colors: skip scene tone mapping.
    this._material.toneMapped = false;
    this._geometry = this.makeGeometry();
    this._mesh = new THREE.Mesh(this._geometry, this._material) as unknown as PanelMesh;
  }

  /** The scene-addable quad (Object3D); position/orient it however you anchor. */
  get mesh(): PanelMesh {
    return this._mesh;
  }
  /** The live DataTexture sampling the composited buffer. */
  get texture(): DataTextureHandle {
    return this._texture;
  }
  /** The quad's material (transparent, unlit, tone-mapping disabled). */
  get material(): MaterialHandle {
    return this._material;
  }
  /** The current composited RGBA buffer + its dimensions. */
  get composited(): Composited {
    return this._composited;
  }
  get width(): number {
    return this._composited.width;
  }
  get height(): number {
    return this._composited.height;
  }
  /** World units per composited texel (the quad's world-size factor). */
  get pixelScale(): number {
    return this._pixelScale;
  }
  /** Where the styled box sits inside the composited buffer (margins from
   *  tail/puffs/callout/shadow); anchors place the box, not the texture. */
  get box(): Composited["box"] {
    return this._composited.box;
  }
  /** The speech-tail's current offset-along-edge (0..1), or undefined when the
   *  panel has no tail. Lets the side-placement pass + tests read how the tail is
   *  aimed (0.5 = centred; >0.5 / <0.5 = shifted toward one corner). */
  get tailOffset(): number | undefined {
    return this.style.tail?.offset;
  }

  /** Update the text (and optional title). Re-composites only if it changed;
   *  returns true when a re-composite happened. */
  setText(text: string, title?: string): boolean {
    this.text = text;
    this.title = title;
    return this.refresh();
  }

  /** Replace the style. Re-composites only if the result changed. */
  setStyle(style: TextStyle): boolean {
    this.style = style;
    return this.refresh();
  }

  /** Re-aim only the speech-tail's offset-along-edge (0..1): the side-placement
   *  pass calls this so the tail keeps pointing back at the speaker after the
   *  bubble slides sideways. The offset never changes the buffer size, so this
   *  re-composites IN PLACE; clamped + quantised (0.02) so sub-pixel jitter does
   *  not re-composite. Returns true when it changed. No-op without a tail. */
  setTailOffset(offset: number): boolean {
    const tail = this.style.tail;
    if (tail === undefined) return false;
    const clamped = offset < 0.1 ? 0.1 : offset > 0.9 ? 0.9 : offset;
    const next = Math.round(clamped * 50) / 50;
    if (tail.offset === next) return false;
    this.style = { ...this.style, tail: { ...tail, offset: next } };
    return this.refresh();
  }

  /** Release GPU resources. The caller removes `mesh` from the scene first. */
  dispose(): void {
    this._texture.dispose();
    this._geometry.dispose();
    this._material.dispose();
  }

  private makeGeometry(): GeometryHandle {
    return new THREE.PlaneGeometry(
      this._composited.width * this._pixelScale,
      this._composited.height * this._pixelScale,
    ) as GeometryHandle;
  }

  private refresh(): boolean {
    const nextKey = Panel.makeKey(this.style, this.text, this.title);
    if (nextKey === this.key) return false;
    const prevW = this._composited.width;
    const prevH = this._composited.height;
    this._composited = composite(this.style, this.text, this.title);
    this.key = nextKey;
    if (this._composited.width === prevW && this._composited.height === prevH) {
      // Same dimensions: overwrite the texture's pixels in place + re-upload.
      this._texture.image.data.set(this._composited.data);
      this._texture.needsUpdate = true;
      return true;
    }
    // Size changed: swap the texture + geometry, dispose the old ones.
    const oldTexture = this._texture;
    const oldGeometry = this._geometry;
    this._texture = makeTexture(this._composited);
    this._material.map = this._texture;
    this._geometry = this.makeGeometry();
    this._mesh.geometry = this._geometry;
    oldTexture.dispose();
    oldGeometry.dispose();
    return true;
  }

  private static makeKey(style: TextStyle, text: string, title: string | undefined): string {
    return JSON.stringify({ s: style, t: text, h: title ?? null });
  }
}
