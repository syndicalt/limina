---
kind: world-bible
setting:
  name: The Eastern Watch
  era: The late Marches, in the years the Blight turned the east road to a dead end.
  premise: The last manned waypost on the frontier holds the line out of habit and duty while the Blight presses against its perimeter.
zone:
  size_m: 200
  origin: hamlet center [0,0]; north = -z (screen-up in the map tool); +x = east (toward the Blight)
regions:
  - id: the-hamlet
    name: The Hamlet
    biome: meadow
    note: The settled clearing — a lawn ringed by forest. Where the people are.
  - id: the-forest-ring
    name: The Forest Ring
    biome: forest
    note: The woods that close the hamlet in on three sides.
  - id: the-blight-edge
    name: The Blight Edge
    biome: blighted
    note: East of the perimeter. Desaturated, dead, encroaching.
locations:
  - id: longhall
    name: Longhall
    kind: civic
    region: the-hamlet
    position: [0, 0]
    build: unbuilt
    note: The muster hall and Grundir's seat. The horizontal anchor of the hamlet.
  - id: cottages
    name: Cottages
    kind: dwelling
    region: the-hamlet
    position: [-19, -8]
    build: unbuilt
    note: A small cluster west of the hall, where the few remaining families live.
  - id: monastery
    name: Monastery
    kind: religious
    region: the-hamlet
    position: [-35, -25]
    build: unbuilt
    note: A quiet order that stayed when the rest left. Set apart to the northwest.
  - id: watchtower
    name: Watchtower
    kind: military
    region: the-hamlet
    position: [30, -12]
    build: unbuilt
    note: On the east rise. The focal vertical; overlooks the Blight frontier.
  - id: signal-fire
    name: Signal Fire
    kind: marker
    region: the-blight-edge
    position: [55, -5]
    build: unbuilt
    note: The last warning beacon, kept lit by rota. The edge of the settled world.
  - id: perimeter
    name: Perimeter Markers
    kind: marker
    region: the-blight-edge
    position: [60, 0]
    build: unbuilt
    note: The line of stones and stakes between settled and blighted, along the east edge.
spawn:
  position: [-55, 0]
  facing: east
  note: The west entrance / east road. The player arrives from the settled lands, hamlet ahead.
compiles_to: world-bible
---

# World Bible — The Eastern Watch

## Setting

The **Eastern Watch** was once a thriving trade-hamlet on the east road — the last
stop before the Marches opened into open country. The country is gone now, taken by
the **Blight**, and the road ends at a line of stones a bowshot east of the hamlet.
What remains is a garrison-in-habit: a few families, an old veteran, a quiet order,
and a warden who still walks the rounds. See [[concept]] for why we're here and
[[art-direction]] for how it reads.

## Regions

- **The Hamlet** — the settled clearing, a [[art-direction|lawn]] ringed by forest. The
  people are here.
- **The Forest Ring** — the woods closing the hamlet on three sides; the world's soft
  wall to the north, south, and west.
- **The Blight Edge** — east of the perimeter. Desaturated, dead, and closer every season.

## Locations

Positions are meters from the hamlet center (`+x` east toward the Blight, north = `-z`).

| Location | Kind | Where | Role |
| --- | --- | --- | --- |
| [[world-bible#Longhall\|Longhall]] | civic | center `[0,0]` | Grundir's hall, the anchor |
| [[world-bible#Cottages\|Cottages]] | dwelling | west `[-25,-8]` | the remaining families |
| [[world-bible#Monastery\|Monastery]] | religious | NW `[-35,-25]` | the order that stayed |
| [[world-bible#Watchtower\|Watchtower]] | military | E rise `[30,-12]` | overlooks the frontier |
| [[world-bible#Signal Fire\|Signal Fire]] | marker | E perimeter `[55,-5]` | the warning beacon |
| [[world-bible#Perimeter Markers\|Perimeter]] | marker | E edge `[60,0]` | the line itself |

### Longhall
The muster hall — long, low, timber-framed, hearth-smoke rising. [[cast#Grundir the Veteran]]
keeps it. The [[storyboard]] passes through here first. *In the build:* `build: unbuilt`
→ will resolve to the placed longhall GLB + its region entity.

### Watchtower
On the east rise, the tallest thing for miles — the focal vertical of [[art-direction#Composition]].
From its top the whole **Blight Edge** lays out east. Storyboard [[storyboard#Beat 2 — The Overlook]].

### Monastery
Set apart to the northwest, a little removed from the hamlet's warmth. The bell still
rings the hours. Storyboard [[storyboard#Beat 3 — The Quiet]].

### Signal Fire & Perimeter
The last lit beacon and the line of stones. Beyond them, the [[cast#Blighted Shambler]]s
in the murk. This is where the settled world stops — and where the game grows next.

## The map

```
                    (forest ring)
        Monastery
           ·                Watchtower
                Longhall       ·          ~ ~ Signal Fire ~ ~
   spawn →  ·      ·                          · Perimeter
        Cottages                        ~ ~ ~ THE BLIGHT ~ ~ ~
        (west / settled)                        (east / edge)
```