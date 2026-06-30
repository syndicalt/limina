// EASTERN WATCH — the Game Design Spec for the Aethon halo loop, authored to make the original UAT
// failures FALSIFIABLE. Its two automated DoDs encode the exact bugs that shipped:
//   - "decline-sticks": choosing decline (choice 1) must NOT accept the quest (the "1/2 doesn't
//      matter, Space always accepts" bug).
//   - "accept-then-turnin": accepting (choice 0), securing the watch-points, and returning must
//      TURN IN the quest and win (the "turn-in never works" bug).
// The content manifest names GENERATED character models for the watcher + Torvald (the "stop using
// the robot rig" note) — sourced by the asset pipeline in the content slice.

import type { GameDesignSpec } from "../gds.ts";

export const EASTERN_WATCH: GameDesignSpec = {
  id: "eastern-watch",
  pitch: "A lone watcher holds a frontier post on the edge of the Blight, taking up Torvald's charge to secure the watch.",
  loopSentence: "Take Torvald's charge, secure the three watch-points (avoid the Blighted ground), return to turn it in — or decline and walk away.",
  controls: {
    scheme: "keyboard-mouse",
    intents: [
      { name: "move", binding: "KeyW/KeyS", description: "walk forward/back" },
      { name: "turn", binding: "KeyA/KeyD", description: "turn" },
      { name: "accept", binding: "Space", description: "accept (choice 0) in dialogue" },
      { name: "decline", binding: "ShiftLeft", description: "decline (choice 1) in dialogue" },
    ],
  },
  winCondition: "Accept Torvald's charge, secure all three watch-points, and return to Torvald to turn in.",
  loseCondition: "The Blighted ground drains the watcher's vitality to zero.",
  artDirection: "A west→east Blight gradient: a warm, living camp gazing into a desaturated, hazed corruption.",
  targetPlatforms: ["desktop", "web"],
  scopeTier: "polished",
  optIn: "record+export",
  entities: [
    { id: "watcher", name: "The Watcher", role: "player", states: ["idle", "walking", "running"] },
    { id: "torvald", name: "Torvald", role: "npc", states: ["waiting", "talking"] },
    { id: "blight", name: "Blighted ground", role: "hazard", states: ["active"] },
  ],
  mechanics: [
    { id: "move", name: "Walk / run", skill: "player.move" },
    { id: "talk", name: "Dialogue with Torvald", skill: "dialogue.start" },
    { id: "accept-quest", name: "Accept the charge", skill: "quest.accept" },
    { id: "turn-in", name: "Turn in (win)", skill: "game.win" },
  ],
  content: [
    { id: "watcher-model", kind: "character", prompt: "weathered frontier watcher in a hooded cloak", source: "3d-ai-studio" },
    { id: "torvald-model", kind: "character", prompt: "grizzled veteran quartermaster, brass-trimmed coat", source: "3d-ai-studio" },
  ],
  dod: [
    {
      id: "accept-then-turnin",
      statement: "Accepting Torvald's charge, securing the three watch-points, and returning TURNS IN the quest and wins.",
      kind: "state-transition",
      drives: {
        description: "Walk to Torvald, accept (choice 0), secure each watch-point, then return to turn in.",
        steps: [
          { toward: "walkToward:torvald", forward: 1, choose: 0, repeat: 800, until: "accepted" },
          { toward: "walkToward:relic-0", forward: 1, repeat: 1000, until: "relic-0" },
          { toward: "walkToward:relic-1", forward: 1, repeat: 1000, until: "relic-1" },
          { toward: "walkToward:relic-2", forward: 1, repeat: 1000, until: "relic-2" },
          { toward: "walkToward:torvald", forward: 1, repeat: 1200, until: "won" },
        ],
        assert: [
          { check: "gameState", value: "won" },
          { check: "questStatus", target: "eastern-watch", value: "completed" },
        ],
      },
    },
    {
      id: "decline-sticks",
      statement: "Choosing decline (choice 1) does NOT accept the quest — it stays unaccepted.",
      kind: "state-transition",
      drives: {
        description: "Walk to Torvald and decline (choice 1) repeatedly; the quest must stay unaccepted.",
        steps: [
          { toward: "walkToward:torvald", forward: 1, choose: 1, repeat: 500 },
        ],
        assert: [
          { check: "flagFalse", target: "accepted" },
          { check: "gameState", value: "playing" },
        ],
      },
    },
    {
      id: "watch-tension",
      statement: "The west→east Blight gradient reads as a tense frontier watch.",
      kind: "feel",
    },
  ],
};
