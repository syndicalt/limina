// DIAGNOSTICS GLOBAL (M5) — the cheap, universal bridge for browser/headless verification. A game
// publishes its live state to a well-known global each frame; the Playwright tier-2 gate
// (tools/director/browser-gate.mjs) reads it to assert the game actually reached its state
// transitions in a real browser (not just that the canvas drew something). This is the limina
// analogue of the reference repo's `window.__THREE_GAME_DIAGNOSTICS__`.

/** The well-known global key a game publishes its diagnostics under. */
export const DIAGNOSTICS_KEY = "__LIMINA_DIAGNOSTICS__";

export interface Diagnostics {
  /** Monotonic frame counter. */
  frame: number;
  /** Current game-state string ("running" | "won" | "lost" | ...). */
  gameState: string;
  /** Named counters (e.g. { relics: 3 }). */
  counters: Record<string, number>;
  /** True once the game has ended (won or lost). */
  complete: boolean;
  /** Player position projected to XZ, when applicable. */
  player?: { x: number; z: number };
  /** Optional renderer stats (draw calls / triangles) for performance evidence. */
  renderer?: { calls?: number; triangles?: number };
}

/** Publish a diagnostics snapshot to the well-known global. Safe in any host (writes to globalThis). */
export function publishDiagnostics(d: Diagnostics): void {
  (globalThis as Record<string, unknown>)[DIAGNOSTICS_KEY] = d;
}

/** Read the last-published diagnostics snapshot, or undefined if none has been published. */
export function readDiagnostics(): Diagnostics | undefined {
  return (globalThis as Record<string, unknown>)[DIAGNOSTICS_KEY] as Diagnostics | undefined;
}
