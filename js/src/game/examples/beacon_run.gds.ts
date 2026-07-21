// BEACON RUN — the Game Design Spec authored through the pipeline's front door (interview intake).
// Creative direction from the user: sprint across a Blight field to light the beacon before the
// lantern drains; touching blighted ground costs light. Win = beacon lit; lose = lantern hits 0.
// Direct-path (instant playable, no record/export). The two automated DoDs encode the win + lose
// state transitions with runnable drive scripts.

import type { GameDesignSpec } from "../gds.ts";

export const BEACON_RUN: GameDesignSpec = {
  id: "beacon-run",
  pitch: "A lone watcher races across a Blight-scarred field to light the signal beacon before the corruption drains the last of the lantern.",
  loopSentence: "Sprint to the beacon and light it before your lantern runs dry — keep off the blighted ground, it drinks the light.",
  controls: {
    scheme: "keyboard-mouse",
    intents: [
      { name: "move", binding: "KeyW/KeyS", description: "walk/run forward and back" },
      { name: "turn", binding: "KeyA/KeyD", description: "turn the watcher" },
      { name: "run", binding: "ShiftLeft", description: "hold to sprint" },
    ],
  },
  winCondition: "Reach and light the signal beacon.",
  loseCondition: "The blighted ground drains the lantern to zero.",
  artDirection: "A west→east Blight gradient: warm lantern light against a desaturated, hazed corruption; the beacon is the bright focal point.",
  targetPlatforms: ["desktop", "web"],
  scopeTier: "prototype",
  optIn: "direct-path",
  entities: [
    { id: "watcher", name: "The Watcher", role: "player", states: ["idle", "walking", "running"] },
    { id: "beacon", name: "Signal Beacon", role: "prop", states: ["dark", "lit"] },
    { id: "blight", name: "Blighted Ground", role: "hazard", states: ["active"] },
  ],
  mechanics: [
    { id: "move", name: "Walk / run", skill: "player.move" },
    { id: "light-beacon", name: "Light the beacon (win)", skill: "game.win" },
    { id: "blight-drain", name: "Lantern drains on the blight (lose)", skill: "game.lose" },
  ],
  // Every resolved asset below is one the game ACTUALLY places (the shared beaconField in
  // beacon_run_scene.ts) — the design gate scores the real placed field, not aspirational content.
  content: [
    // The watcher (player) — still procedural design intent (no resolved glb yet → the gate skips it).
    { id: "watcher-model", kind: "character", prompt: "lantern-bearing frontier watcher", source: "procedural" },
    // The BEACON is a signal-fire pile you reach and set roaring — NOT a tower. Placed as the campfire.
    { id: "beacon-fire", kind: "prop", tier: "beacon", asset: "prop-campfire-1.glb", prompt: "stacked signal-fire pile, dim embers until lit then a roaring blaze", source: "poly-pizza", readContract: "the goal — reach it and set it roaring to win" },
    { id: "blight-ground", kind: "environment", prompt: "desaturated cracked blight crust, west→east gradient", source: "procedural" },
    // Vegetation tier — the field's living-vs-blighted read; their silhouettes must differ.
    { id: "pine", kind: "environment", tier: "vegetation", asset: "vegetation-pine-tree-1.glb", prompt: "living pine, healthy west", source: "poly-pizza", readContract: "safe living vegetation" },
    { id: "dead-tree", kind: "environment", tier: "vegetation", asset: "vegetation-dead-tree-1.glb", prompt: "blighted dead tree, east", source: "poly-pizza", readContract: "blighted vegetation — the hazard direction" },
    { id: "broadleaf", kind: "environment", tier: "vegetation", asset: "broadleaf.glb", prompt: "broadleaf, west grove", source: "poly-pizza" },
    { id: "bush", kind: "environment", tier: "vegetation", asset: "bush.glb", prompt: "low brush ground cover", source: "poly-pizza" },
    // Scatter tier — camp + field clutter.
    { id: "rock", kind: "prop", tier: "scatter", asset: "rock.glb", prompt: "scattered field rocks", source: "poly-pizza" },
    { id: "barrel", kind: "prop", tier: "scatter", asset: "prop-barrel-1.glb", prompt: "the watcher's supply barrels at camp", source: "poly-pizza" },
  ],
  dod: [
    {
      id: "reaching-beacon-wins",
      statement: "Reaching and lighting the beacon (along a clear path) wins the run.",
      kind: "state-transition",
      drives: {
        description: "Walk straight to the beacon (the clear path, away from the blight); it lights and the run is won.",
        steps: [{ toward: "walkToward:beacon", forward: 1, repeat: 800, until: "reached" }],
        assert: [
          { check: "gameState", value: "won" },
          { check: "flagTrue", target: "beacon-lit" },
        ],
      },
    },
    {
      id: "blight-drains-lantern",
      statement: "Walking onto the blighted ground drains the lantern to zero and loses the run.",
      kind: "state-transition",
      drives: {
        description: "Walk into the blight and stay; the lantern drains to zero and the run is lost.",
        steps: [{ toward: "walkToward:blight", forward: 1, repeat: 800 }],
        assert: [{ check: "gameState", value: "lost" }],
      },
    },
    {
      id: "lantern-tension",
      statement: "The drain reads as real pressure — the player feels the lantern running out.",
      kind: "feel",
    },
  ],
};
