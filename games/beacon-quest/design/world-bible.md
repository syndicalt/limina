---
kind: world-bible
setting:
  name: The Eastern Watch
  era: The late Marches, in the years the Blight turned the east road to a dead end.
  premise: The last manned waypost on the frontier. The warden holds the line and needs the eastern beacon lit before dark.
zone:
  size_m: 560
  origin: camp center [0,0]; north = -z (screen-up in the map tool); +x = east (toward the Blight)
regions:
  - id: the-camp
    name: The Warden's Camp
    biome: meadow
    note: The settled centre — a hall and two cottages on a gentle knoll, ringed by wood.
  - id: the-forest-ring
    name: The Forest Ring
    biome: forest
    note: The woods closing the camp on the north and west; the beacon road threads a gap.
  - id: the-beacon-headland
    name: The Beacon Headland
    biome: mountain
    note: A bare rock hill to the east over open water. The beacon crowns it.
  - id: the-blight-edge
    name: The Blight Edge
    biome: blighted
    note: The dead swamp fouling the south-east shore. Standing water and sick ground.
locations:
  - id: hall
    name: The Warden's Hall
    kind: civic
    region: the-camp
    position: [-40, 18]
    build: stamped
    note: The muster hall and the warden's seat — where the quest is given and turned in.
  - id: beacon
    name: The Eastern Beacon
    kind: military
    region: the-beacon-headland
    position: [150, -20]
    build: stamped
    note: The unlit signal tower on the headland. The quest objective.
---

# The Eastern Watch

The last manned waypost on the frontier. Light the Eastern Beacon before dark.
