import * as THREE from "../../build/three.bundle.mjs";

export const UNDERWATER_BACKGROUND_COLOR = 0x0b5361;
export const UNDERWATER_FOG_DENSITY = 0.055;

type UnderwaterScene = Pick<THREE.Scene, "background" | "fog"> & { fogNode?: unknown };

/** Session-owned underwater atmosphere. The dry path is a strict no-op; entering
 * swaps in preallocated resources and leaving restores the exact captured references. */
export class UnderwaterEffect {
  readonly #background = new THREE.Color(UNDERWATER_BACKGROUND_COLOR);
  readonly #fog = new THREE.FogExp2(UNDERWATER_BACKGROUND_COLOR, UNDERWATER_FOG_DENSITY);
  readonly #scene: UnderwaterScene;
  #baselineBackground: THREE.Scene["background"] = null;
  #baselineFog: THREE.Scene["fog"] = null;
  #baselineFogNode: unknown;
  #submerged = false;
  #disposed = false;

  constructor(scene: UnderwaterScene) {
    this.#scene = scene;
  }

  get submerged(): boolean { return this.#submerged; }
  get disposed(): boolean { return this.#disposed; }

  update(submerged: boolean): void {
    if (this.#disposed || submerged === this.#submerged) return;
    if (submerged) {
      this.#baselineBackground = this.#scene.background;
      this.#baselineFog = this.#scene.fog;
      this.#baselineFogNode = this.#scene.fogNode;
      this.#scene.background = this.#background;
      this.#scene.fog = this.#fog;
      this.#scene.fogNode = null;
      this.#submerged = true;
      return;
    }
    this.#restore();
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#submerged) this.#restore();
    this.#disposed = true;
  }

  #restore(): void {
    this.#scene.background = this.#baselineBackground;
    this.#scene.fog = this.#baselineFog;
    this.#scene.fogNode = this.#baselineFogNode;
    this.#submerged = false;
  }
}
