---
kind: world-bible
setting:
  name: WB-W1 Generated Water
  era: Browser acceptance fixture.
  premise: A closed high rim drains into a broad central bowl.
zone:
  size_m: 64
  origin: bowl center [0,0]
regions:
  - id: bowl
    name: Bowl
    biome: grass
    note: Deterministic generated-water acceptance terrain.
locations: []
spawn:
  position: [0, 0]
  facing: north
  note: Centered on the generated basin.
compiles_to: world-bible
---

# WB-W1 Generated Water

This source-controlled fixture mirrors the closed-rim relief used by
`js/test/p_wb_w1_acceptance.ts` so browser and non-browser acceptance exercise the same terrain.
