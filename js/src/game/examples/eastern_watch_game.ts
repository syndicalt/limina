// EASTERN WATCH — the reference game for the EASTERN_WATCH GDS (M6 dogfood). It is backed by the
// PROVEN capstone dialogue/quest sim (the working accept/decline + quest turn-in logic that Aethon
// copied but never gated), themed as the watch: Torvald is the quest-giver, the watch-points are the
// relics, and turning in (returning to Torvald with all three) wins. Exposed as a GameUnderTest so
// the functional gate can DRIVE the exact transitions that broke in UAT — proving the dialogue
// branches (decline ≠ accept) and the turn-in fires.

import { buildCapstone, CAPSTONE_LAYOUT, type Capstone } from "../../demos/capstone_game.ts";
import type { GameContext } from "../context.ts";
import type { GameUnderTest, SimInput } from "../gate.ts";

/** Build the Eastern Watch game on `ctx` (fresh physics world + the authored capstone sim) and
 *  return the GameUnderTest the gate drives. */
export async function buildEasternWatchGame(ctx: GameContext): Promise<GameUnderTest> {
  ctx.ops.op_physics_create_world(-9.81);
  const cap: Capstone = await buildCapstone({
    world: ctx.world, registry: ctx.registry, core: ctx.core, base: ctx.base,
  });
  const qm = ctx.core.quest.questManager;

  return {
    async step(input: SimInput, dt: number): Promise<void> {
      await cap.step(dt, {
        forward: input.forward,
        strafe: input.strafe,
        yaw: input.yaw,
        run: input.run,
        jump: input.jump,
        choose: input.choose,
      });
    },
    playerXZ(): readonly [number, number] {
      const p = cap.playerPos();
      return [p[0], p[2]];
    },
    resolveXZ(ref: string): readonly [number, number] | undefined {
      if (ref === "torvald") {
        const n = cap.npcPos();
        return [n[0], n[2]];
      }
      const relic = /^relic-(\d+)$/.exec(ref);
      if (relic) {
        const r = CAPSTONE_LAYOUT.relics[Number(relic[1])];
        return r ? [r[0], r[1]] : undefined;
      }
      const xz = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(ref);
      return xz ? [Number(xz[1]), Number(xz[2])] : undefined;
    },
    predicate(name: string): boolean {
      if (name === "accepted") return cap.accepted();
      if (name === "won") return cap.state() === "won";
      const relic = /^relic-(\d+)$/.exec(name);
      if (relic) return cap.relics() >= Number(relic[1]) + 1;
      return false;
    },
    gameState(): string {
      return cap.state();
    },
    counter(name: string): number {
      return name === "relics" ? cap.relics() : ctx.core.gamestate.gameStateManager.getCounter(name);
    },
    flag(name: string): boolean {
      // The watch's "accepted" flag IS whether the quest was accepted via the dialogue — the exact
      // state that must NOT flip on a decline.
      return name === "accepted" ? cap.accepted() : ctx.core.gamestate.gameStateManager.getFlag(name);
    },
    hp(): number {
      return cap.hp();
    },
    questStatus(): string | undefined {
      const inst = qm.getInstance(cap.playerEntity, cap.questId);
      return inst ? inst.status : undefined;
    },
  };
}
