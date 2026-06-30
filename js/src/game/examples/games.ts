// REGISTERED GAMES — the reference games the slice gate can run, keyed by GDS id. The SliceBuilder's
// codegen stage (provider-gated) would PRODUCE a slice's game; until a provider is wired, the gate
// runs a registered reference game SELECTED BY THE SLICE (data-driven) rather than a hardcoded one.
// New games register here and become gate-able by id.

import type { GameContext } from "../context.ts";
import type { GameUnderTest } from "../gate.ts";
import type { GameDesignSpec } from "../gds.ts";
import { RELIC_SPRINT } from "./relic_sprint.gds.ts";
import { buildRelicSprintGame } from "./relic_sprint_game.ts";
import { EASTERN_WATCH } from "./eastern_watch.gds.ts";
import { buildEasternWatchGame } from "./eastern_watch_game.ts";
import { BEACON_RUN } from "./beacon_run.gds.ts";
import { buildBeaconRunGame } from "./beacon_run_game.ts";

export interface RegisteredGame {
  gds: GameDesignSpec;
  /** Build the game-under-test on a context. `broken` (where supported) omits a transition so the
   *  gate goes red — used to prove the slice loop is falsifiable. */
  build(ctx: GameContext, opts?: { broken?: boolean }): GameUnderTest | Promise<GameUnderTest>;
}

export const GAMES: Record<string, RegisteredGame> = {
  "relic-sprint": {
    gds: RELIC_SPRINT,
    build: (ctx, opts) => buildRelicSprintGame(ctx, opts),
  },
  "eastern-watch": {
    gds: EASTERN_WATCH,
    build: (ctx) => buildEasternWatchGame(ctx), // capstone-backed; no broken variant
  },
  "beacon-run": {
    gds: BEACON_RUN,
    build: (ctx, opts) => buildBeaconRunGame(ctx, opts),
  },
};

export function getGame(id: string): RegisteredGame | undefined {
  return GAMES[id];
}
