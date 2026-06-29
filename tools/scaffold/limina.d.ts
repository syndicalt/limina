// Editor-only type surface for `world.ts`.
//
// This declares the shape of the handles your `buildWorld` receives. It exists
// purely so your editor gives you autocomplete + type-checking. At RUNTIME the
// `import type { ... } from "limina"` in `world.ts` is erased by the limina
// TypeScript loader, so nothing here is ever loaded or required on disk — you do
// NOT need limina installed as a package to run `world.ts`.
//
// The real implementations live in the limina engine; the export harness
// (`scripts/export.mjs`) wires them up and calls your `buildWorld`.

declare module "limina" {
  /** The uniform response every skill returns. */
  export interface SkillResult {
    success: boolean;
    result?: unknown;
    error?: unknown;
  }

  /** Per-invoke context carrying the actor id, session, permissions and tick. */
  export interface InvokeBase {
    agentId: string;
    sessionId: string;
    permissions: unknown;
    tick: number;
    world: WorldContext;
  }

  /** The permissioned skill surface. `invoke` is how you author the world. */
  export interface Registry {
    /** Call a named skill (e.g. "world.generateRegion") with a typed input. */
    invoke(tool: string, input: Record<string, unknown>, base: InvokeBase): Promise<SkillResult>;
  }

  /** The live world the skills mutate (ECS, scene, ops, …). Opaque to authors. */
  export interface WorldContext {
    readonly mode: "headless" | "windowed";
    [key: string]: unknown;
  }

  /** The registered core skill managers (terrain cache, asset bundle, …). The
   *  export harness reads these to bake the package; authors rarely need them. */
  export interface CoreSkills {
    [key: string]: unknown;
  }

  /** The orbit-camera framing baked into `view.json` and used by the browser
   *  player to frame your world. All distances are in world units. */
  export interface WorldView {
    /** The point the camera orbits + looks at. */
    center: [number, number, number];
    /** Initial orbit radius. */
    radius: number;
    /** Initial camera height above `center`. */
    height: number;
    /** Maximum scroll-out radius. */
    maxRadius: number;
    /** Maximum camera height. */
    maxHeight: number;
    /** Camera far-plane (large worlds need a pushed-out far). */
    far: number;
  }

  /** What `buildWorld` is handed. */
  export interface BuildWorldArgs {
    registry: Registry;
    base: InvokeBase;
    world: WorldContext;
    core: CoreSkills;
  }

  /** What `buildWorld` may return — an optional camera framing + a one-line
   *  summary printed by the exporter. Return nothing for a default orbit. */
  export interface BuildWorldResult {
    view?: WorldView;
    summary?: string;
  }

  /** The signature your default export must satisfy. */
  export type BuildWorld = (args: BuildWorldArgs) => Promise<BuildWorldResult | void>;
}
