// BEACON RUN — the direct-path game, authored from the BEACON_RUN GDS (Stage 3 of the pipeline; the
// coordinator AGENT writes this — no external codegen). Zero registry.invoke on the hot path: a
// CharacterController for movement + the GameStateManager for the lantern counter, the beacon-lit
// flag, and the win/lose transitions. Reaching the beacon lights it → WIN; standing on the blight
// drains the lantern → at zero, LOSE.
//
// The `broken` switch omits the win transition (the beacon lights but the run never wins) so the
// functional gate is provably falsifiable.

import { CharacterController } from "../../world/character.ts";
import type { GameContext } from "../context.ts";
import type { GameUnderTest, SimInput } from "../gate.ts";

const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS;
// Canonical world positions — exported so the SHARED dressed-scene (beacon_run_scene.ts) places its
// field around the SAME beacon/blight the sim uses; the playable build and the exported release agree.
export const BEACON_XZ: readonly [number, number] = [0, -12]; // straight ahead (-Z); the clear path
export const BLIGHT_XZ: readonly [number, number] = [10, 0]; // off to the side (+X); only entered on purpose
const BEACON_RADIUS = 1.6; // > the gate's 1.2 reach, so lighting lands by the time "reached" triggers
export const BLIGHT_RADIUS = 3.5;
const LANTERN_START = 100;
const DRAIN = 3; // lantern lost per step on the blight

export interface BeaconRunOptions {
  /** When true, the beacon still lights (flag set) but the WIN transition never fires. */
  broken?: boolean;
}

/** The Beacon Run game: the gate's GameUnderTest plus the render-facing handles a windowed build
 *  needs (the controller to pose the player, the marker positions, and the live lit/lantern state). */
export interface BeaconRunGame extends GameUnderTest {
  readonly player: CharacterController;
  readonly beaconXZ: readonly [number, number];
  readonly blightXZ: readonly [number, number];
  readonly beaconRadius: number;
  readonly blightRadius: number;
  lit(): boolean;
  lantern(): number;
  lanternMax(): number;
}

function parseXZ(ref: string): [number, number] | undefined {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(ref.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Build the Beacon Run game on `ctx` (fresh physics world + flat ground + the player capsule). */
export function buildBeaconRunGame(ctx: GameContext, opts: BeaconRunOptions = {}): BeaconRunGame {
  const broken = opts.broken ?? false;
  const gs = ctx.core.gamestate.gameStateManager;

  ctx.ops.op_physics_create_world(-9.81);
  ctx.ops.op_physics_add_ground(0);
  const player = new CharacterController(ctx.ops, [0, GROUND_OFFSET, 0], { halfHeight: HALF, radius: RADIUS });

  let tick = 0;
  let lit = false;
  let lantern = LANTERN_START;
  gs.setCounter("lantern", lantern);

  const onBlight = (): boolean => {
    const p = player.position;
    const dx = p[0] - BLIGHT_XZ[0], dz = p[2] - BLIGHT_XZ[1];
    return Math.sqrt(dx * dx + dz * dz) <= BLIGHT_RADIUS; // sqrt: IEEE correctly-rounded, bit-stable (Math.hypot is not)
  };

  return {
    step(input: SimInput, dt: number): void {
      ctx.setTick(tick);
      player.step(
        { forward: input.forward, strafe: input.strafe, yaw: input.yaw, run: input.run, jump: input.jump },
        dt,
      );
      ctx.ops.op_physics_step();

      if (gs.getState().state === "running") {
        // The blight drinks the lantern; at zero, the run is lost.
        if (onBlight()) {
          lantern = Math.max(0, lantern - DRAIN);
          gs.setCounter("lantern", lantern);
          if (lantern <= 0) gs.lose(tick);
        }
        // Lighting the beacon wins (re-read state in case the lose just fired this step).
        if (gs.getState().state === "running" && !lit) {
          const p = player.position;
          const bdx = p[0] - BEACON_XZ[0], bdz = p[2] - BEACON_XZ[1];
          if (Math.sqrt(bdx * bdx + bdz * bdz) <= BEACON_RADIUS) {
            lit = true;
            gs.setFlag("beacon-lit", true);
            if (!broken) gs.win(tick); // the transition the broken build omits
          }
        }
      }
      tick++;
    },
    playerXZ(): readonly [number, number] {
      const p = player.position;
      return [p[0], p[2]];
    },
    resolveXZ(ref: string): readonly [number, number] | undefined {
      if (ref === "beacon") return BEACON_XZ;
      if (ref === "blight") return BLIGHT_XZ;
      return parseXZ(ref);
    },
    predicate(name: string): boolean {
      if (name === "reached" || name === "lit") return lit;
      if (name === "on-blight") return onBlight();
      return false;
    },
    gameState(): string {
      return gs.getState().state;
    },
    counter(name: string): number {
      return gs.getCounter(name);
    },
    flag(name: string): boolean {
      return gs.getFlag(name);
    },
    hp(): number {
      return lantern;
    },
    questStatus(): string | undefined {
      return undefined;
    },
    // Render-facing handles (for the windowed build):
    player,
    beaconXZ: BEACON_XZ,
    blightXZ: BLIGHT_XZ,
    beaconRadius: BEACON_RADIUS,
    blightRadius: BLIGHT_RADIUS,
    lit(): boolean {
      return lit;
    },
    lantern(): number {
      return lantern;
    },
    lanternMax(): number {
      return LANTERN_START;
    },
  };
}
