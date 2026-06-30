// RELIC SPRINT — the reference DIRECT-PATH game for the RELIC_SPRINT GDS (M3 fixture + an M4
// down-payment). Built entirely on the substrate with ZERO registry.invoke on the hot path: a
// CharacterController for movement + the GameStateManager for the relic counter and the win state.
// On proximity the relic auto-collects (counter "relics" -> 1) and the game wins.
//
// The `broken` switch reproduces the exact class of bug that shipped in Aethon: the pickup fires
// and the counter advances, but the WIN transition never does — so the functional gate goes red on
// the gameState assertion while the counter assertion still passes. That makes the M3 gate provably
// falsifiable (red on a broken branch, green when fixed).

import { CharacterController } from "../../world/character.ts";
import type { GameContext } from "../context.ts";
import type { GameUnderTest, SimInput } from "../gate.ts";

const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS;
const RELIC_XZ: readonly [number, number] = [0, -8];
const PICKUP_RADIUS = 1.4; // slightly larger than the gate's reach (1.2) so collection lands by "reached"

export interface RelicSprintOptions {
  /** When true, the relic still collects (counter advances) but the WIN transition never fires —
   *  the "turn-in never completes" bug, for proving the gate is falsifiable. */
  broken?: boolean;
}

function parseXZ(ref: string): [number, number] | undefined {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(ref.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Build the reference relic-sprint game on `ctx`. Creates a fresh physics world + flat ground +
 *  the player capsule, and returns the GameUnderTest the functional gate drives. */
export function buildRelicSprintGame(ctx: GameContext, opts: RelicSprintOptions = {}): GameUnderTest {
  const broken = opts.broken ?? false;
  const gamestate = ctx.core.gamestate.gameStateManager;

  ctx.ops.op_physics_create_world(-9.81);
  ctx.ops.op_physics_add_ground(0);
  const player = new CharacterController(ctx.ops, [0, GROUND_OFFSET, 0], { halfHeight: HALF, radius: RADIUS });
  gamestate.setCounter("relics", 0);

  let tick = 0;
  let collected = false;

  return {
    step(input: SimInput, dt: number): void {
      ctx.setTick(tick);
      player.step(
        { forward: input.forward, strafe: input.strafe, yaw: input.yaw, run: input.run, jump: input.jump },
        dt,
      );
      ctx.ops.op_physics_step();
      if (!collected) {
        const p = player.position;
        if (Math.hypot(p[0] - RELIC_XZ[0], p[2] - RELIC_XZ[1]) <= PICKUP_RADIUS) {
          collected = true;
          gamestate.setCounter("relics", 1);
          if (!broken) gamestate.win(tick); // the transition the broken build omits
        }
      }
      tick++;
    },
    playerXZ(): readonly [number, number] {
      const p = player.position;
      return [p[0], p[2]];
    },
    resolveXZ(ref: string): readonly [number, number] | undefined {
      if (ref === "relic") return RELIC_XZ;
      return parseXZ(ref);
    },
    predicate(name: string): boolean {
      return (name === "reached" || name === "collected") ? collected : false;
    },
    gameState(): string {
      return gamestate.getState().state;
    },
    counter(name: string): number {
      return gamestate.getCounter(name);
    },
    flag(name: string): boolean {
      return gamestate.getFlag(name);
    },
    hp(): number {
      return 100;
    },
    questStatus(): string | undefined {
      return undefined;
    },
  };
}
