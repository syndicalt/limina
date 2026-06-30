// RELIC SPRINT — the hand-authored tiny Game Design Spec (M2). A minimal but COMPLETE spec:
// one player, one pickup, a win condition, and a falsifiable state-transition DoD with a runnable
// drive script (plus a "feel" DoD for the human UAT pass). This is the fixture the M3 functional
// gate generator and the M4 coordinator first build against.

import type { GameDesignSpec } from "../gds.ts";

export const RELIC_SPRINT: GameDesignSpec = {
  id: "relic-sprint",
  pitch: "A bite-size dash: sprint across a small arena and grab the lone relic to win.",
  loopSentence: "Run to the relic, grab it, win — restart instantly to beat your time.",
  controls: {
    scheme: "keyboard-mouse",
    intents: [
      { name: "move-forward", binding: "KeyW", description: "walk/run forward" },
      { name: "turn", binding: "KeyA/KeyD", description: "turn the runner" },
      { name: "run", binding: "ShiftLeft", description: "hold to sprint" },
    ],
  },
  winCondition: "The player reaches and collects the relic.",
  loseCondition: "None — a run can always be restarted.",
  artDirection: "Clean low-poly arena under a warm key light; the relic glows as the focal point.",
  targetPlatforms: ["desktop", "web"],
  scopeTier: "prototype",
  optIn: "direct-path",
  entities: [
    { id: "player", name: "Runner", role: "player", states: ["idle", "running"] },
    { id: "relic", name: "Relic", role: "pickup", states: ["uncollected", "collected"] },
  ],
  mechanics: [
    { id: "move", name: "Walk / run", skill: "player.move" },
    { id: "pickup", name: "Collect the relic", skill: "interaction.pickup" },
    { id: "win", name: "Win on collect", skill: "game.win" },
  ],
  content: [
    { id: "player-model", kind: "character", prompt: "stylized low-poly runner", source: "procedural" },
    { id: "relic-prop", kind: "prop", prompt: "glowing relic orb on a pedestal", source: "poly-pizza" },
  ],
  dod: [
    {
      id: "collect-wins",
      statement: "Collecting the relic wins the game.",
      kind: "state-transition",
      drives: {
        description: "Walk straight to the relic; it auto-collects and the game transitions to won.",
        steps: [{ forward: 1, toward: "walkToward:relic", repeat: 600, until: "reached" }],
        assert: [
          { check: "gameState", value: "won" },
          { check: "counterAtLeast", target: "relics", value: 1 },
        ],
      },
    },
    {
      id: "feels-snappy",
      statement: "Movement feels responsive (sub-100ms input-to-move).",
      kind: "feel",
    },
  ],
};
