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
  content: [
    // Design intent still being sourced (no resolved glb yet → the silhouette gate skips these):
    { id: "watcher-model", kind: "character", prompt: "lantern-bearing frontier watcher", source: "procedural" },
    { id: "beacon-prop", kind: "prop", prompt: "tall iron signal brazier, glowing when lit", source: "poly-pizza" },
    { id: "blight-ground", kind: "environment", prompt: "desaturated cracked blighted ground crust", source: "procedural" },
    // Resolved placed assets, grouped into silhouette tiers — the design gate scores distinctness WITHIN a tier.
    { id: "pine", kind: "environment", tier: "vegetation", asset: "pine.glb", prompt: "living pine, healthy west edge", source: "poly-pizza", readContract: "safe living vegetation" },
    { id: "dead-tree", kind: "environment", tier: "vegetation", asset: "vegetation-dead-tree-1.glb", prompt: "blighted dead tree, east", source: "poly-pizza", readContract: "blighted vegetation — the hazard direction" },
    { id: "broadleaf", kind: "environment", tier: "vegetation", asset: "broadleaf.glb", prompt: "broadleaf, the camp grove", source: "poly-pizza" },
    { id: "bush", kind: "environment", tier: "vegetation", asset: "bush.glb", prompt: "low brush ground cover", source: "poly-pizza" },
    { id: "watchtower", kind: "prop", tier: "structure", asset: "building-wooden-watchtower-1.glb", prompt: "the signal watchtower", source: "poly-pizza", readContract: "the goal — climb to light it" },
    { id: "cottage", kind: "prop", tier: "structure", asset: "cottage.glb", prompt: "the watcher's cottage", source: "poly-pizza" },
    { id: "well", kind: "prop", tier: "structure", asset: "prop-water-well-1.glb", prompt: "the camp well", source: "poly-pizza" },
    { id: "rock", kind: "prop", tier: "scatter", asset: "rock.glb", prompt: "scattered rocks", source: "poly-pizza" },
    { id: "barrel", kind: "prop", tier: "scatter", asset: "prop-barrel-1.glb", prompt: "supply barrels at the camp", source: "poly-pizza" },
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
