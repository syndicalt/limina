// WB-B2 taxonomy metadata. This deliberately contains symbolic roles only: every definition is
// metadata-only until licensed, content-addressed materials/assets/tables/audio are bound later.

import { BIOME_DEF_SCHEMA, BIOME_PACK_SCHEMA, parseBiomePack } from "./biome-ir.mjs";

const VERSION = "1.0.1";
const provenance = (id) => ({ sourceUri: `limina://biomes/v1/${id}`, licenseId: "CC0-1.0", authoredBy: "Limina Project" });
const definition = (id, displayName, category, tags, temperatureC, moisture01, surfaceRoles, vegetation, waterTintSrgb) => ({
  schema: BIOME_DEF_SCHEMA,
  id, version: VERSION, displayName,
  taxonomy: { category, tags: [...tags].sort() },
  climate: { temperatureC: { min: temperatureC[0], max: temperatureC[1] }, moisture01: { min: moisture01[0], max: moisture01[1] } },
  surfaceMaterials: surfaceRoles.map((role) => ({ role })),
  vegetationPalette: vegetation.map(([role, weight]) => ({ role, weight })).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0),
  resourceTableRefs: [`tables/resources/${id}`],
  spawnTableRefs: [`tables/spawns/${id}`],
  waterTintSrgb,
  ambientAudioRefs: [`audio/ambient/${id}`],
  fulfillment: { status: "metadata-only", bindings: [] },
  provenance: provenance(id),
});

const definitions = [
  definition("alpine", "Alpine", "terrestrial", ["cold", "highland"], [-18, 8], [0.2, 0.8], ["ground/alpine-turf", "rock/granite", "ground/snow"], [["flora/alpine-grass", 3], ["flora/lichen", 1]], [96, 151, 177]),
  definition("atoll", "Atoll", "aquatic", ["coastal", "tropical"], [22, 38], [0.55, 1], ["ground/coral-sand", "ground/reef-limestone"], [["flora/coconut-palm", 3], ["flora/tropical-scrub", 1]], [54, 190, 205]),
  definition("badlands", "Badlands", "geological", ["arid", "eroded"], [4, 42], [0, 0.28], ["rock/banded-sediment", "ground/dry-clay"], [["flora/desert-scrub", 1]], [109, 142, 139]),
  definition("blighted-waste", "Blighted Waste", "fantasy", ["corruption", "hostile"], [-5, 36], [0, 0.65], ["ground/blighted-soil", "rock/blighted"], [["flora/blight-thorn", 3], ["flora/deadwood", 2]], [79, 76, 94]),
  definition("bog", "Bog", "wetland", ["acidic", "peat"], [-2, 22], [0.75, 1], ["ground/peat", "ground/sphagnum"], [["flora/bog-shrub", 1], ["flora/sphagnum", 4]], [79, 103, 82]),
  definition("boreal-forest", "Boreal Forest", "terrestrial", ["cold", "coniferous"], [-25, 16], [0.35, 0.9], ["ground/forest-duff", "ground/moss", "rock/granite"], [["flora/fir", 3], ["flora/spruce", 5]], [66, 109, 124]),
  definition("canyon", "Canyon", "geological", ["cliff", "river-cut"], [-4, 42], [0.05, 0.55], ["rock/canyon-sandstone", "ground/scree"], [["flora/riparian-shrub", 1]], [82, 136, 142]),
  definition("coral-reef", "Coral Reef", "aquatic", ["marine", "tropical"], [18, 34], [1, 1], ["ground/coral-rubble", "ground/reef-sand"], [["flora/coral-branch", 5], ["flora/sea-fan", 2]], [32, 157, 188]),
  definition("crystal", "Crystal Expanse", "fantasy", ["arcane", "mineral"], [-20, 45], [0, 0.7], ["rock/crystal-bed", "ground/crystal-dust"], [["flora/crystal-growth", 4]], [99, 125, 201]),
  definition("deep-ocean", "Deep Ocean", "aquatic", ["abyssal", "marine"], [-2, 12], [1, 1], ["ground/abyssal-silt", "rock/basalt"], [["flora/deep-kelp", 1]], [12, 37, 76]),
  definition("desert", "Hot Desert", "terrestrial", ["arid", "hot"], [16, 50], [0, 0.2], ["ground/desert-sand", "rock/desert-varnish"], [["flora/cactus", 2], ["flora/desert-scrub", 1]], [79, 139, 155]),
  definition("enchanted-forest", "Enchanted Forest", "fantasy", ["arcane", "forest"], [2, 28], [0.55, 1], ["ground/enchanted-duff", "ground/luminous-moss"], [["flora/ancient-broadleaf", 4], ["flora/luminous-fern", 2]], [78, 131, 153]),
  definition("estuary", "Estuary", "wetland", ["brackish", "coastal"], [2, 32], [0.7, 1], ["ground/estuary-mud", "ground/tidal-sand"], [["flora/saltmarsh-grass", 4], ["flora/tidal-reed", 2]], [87, 142, 144]),
  definition("floating-island", "Floating Island", "fantasy", ["aerial", "highland"], [-8, 30], [0.2, 0.9], ["ground/aerial-turf", "rock/floating-island"], [["flora/aerial-grass", 3], ["flora/wind-tree", 1]], [111, 170, 195]),
  definition("fungal", "Fungal Wilds", "fantasy", ["fungal", "humid"], [2, 30], [0.7, 1], ["ground/fungal-loam", "ground/mycelium"], [["flora/giant-fungus", 3], ["flora/spore-cap", 4]], [91, 88, 134]),
  definition("glacier", "Glacier", "geological", ["ice", "polar"], [-60, 2], [0.1, 0.8], ["ground/glacial-ice", "ground/snow", "rock/glacial-till"], [["flora/ice-lichen", 1]], [100, 169, 202]),
  definition("grassland", "Temperate Grassland", "terrestrial", ["grassland", "temperate"], [-8, 30], [0.2, 0.7], ["ground/grass-turf", "ground/loam"], [["flora/meadow-grass", 5], ["flora/wildflower", 1]], [75, 133, 151]),
  definition("kelp-forest", "Kelp Forest", "aquatic", ["coastal", "marine"], [2, 22], [1, 1], ["ground/coastal-rock", "ground/marine-sand"], [["flora/giant-kelp", 5], ["flora/sea-grass", 2]], [31, 111, 126]),
  definition("lava-field", "Lava Field", "geological", ["igneous", "volcanic"], [10, 80], [0, 0.4], ["rock/basalt", "rock/lava-crust"], [["flora/fire-lichen", 1]], [97, 72, 55]),
  definition("mangrove", "Mangrove", "wetland", ["coastal", "tropical"], [18, 40], [0.8, 1], ["ground/mangrove-mud", "ground/tidal-silt"], [["flora/mangrove-tree", 5], ["flora/tidal-root", 3]], [74, 130, 117]),
  definition("marsh", "Marsh", "wetland", ["freshwater", "reeds"], [-2, 30], [0.75, 1], ["ground/marsh-mud", "ground/wet-grass"], [["flora/cattail", 3], ["flora/marsh-reed", 5]], [93, 137, 126]),
  definition("mediterranean-shrubland", "Mediterranean Shrubland", "terrestrial", ["dry-summer", "shrubland"], [4, 38], [0.15, 0.6], ["ground/dry-loam", "rock/limestone"], [["flora/aromatic-shrub", 3], ["flora/olive-tree", 1]], [77, 135, 153]),
  definition("mesa", "Mesa", "geological", ["arid", "plateau"], [2, 44], [0, 0.3], ["rock/mesa-sandstone", "ground/desert-gravel"], [["flora/desert-scrub", 1]], [91, 139, 148]),
  definition("montane-forest", "Montane Forest", "terrestrial", ["forest", "highland"], [-12, 22], [0.35, 0.9], ["ground/montane-duff", "rock/granite", "ground/snow"], [["flora/fir", 3], ["flora/montane-pine", 5]], [73, 127, 149]),
  definition("nether", "Nether", "fantasy", ["infernal", "hostile"], [25, 100], [0, 0.5], ["rock/infernal", "ground/ash"], [["flora/ember-fungus", 2], ["flora/infernal-thorn", 3]], [117, 47, 35]),
  definition("ocean", "Ocean", "aquatic", ["marine", "pelagic"], [-2, 32], [1, 1], ["ground/marine-sand", "ground/marine-silt"], [["flora/sea-grass", 1]], [24, 108, 148]),
  definition("polar-desert", "Polar Desert", "terrestrial", ["arid", "polar"], [-70, 4], [0, 0.2], ["ground/polar-gravel", "ground/snow"], [["flora/polar-lichen", 1]], [86, 139, 163]),
  definition("prairie", "Prairie", "terrestrial", ["grassland", "temperate"], [-12, 34], [0.25, 0.7], ["ground/prairie-turf", "ground/black-soil"], [["flora/prairie-grass", 5], ["flora/prairie-wildflower", 2]], [74, 131, 148]),
  definition("rainforest", "Tropical Rainforest", "terrestrial", ["forest", "tropical"], [18, 40], [0.75, 1], ["ground/rainforest-duff", "ground/wet-loam"], [["flora/rainforest-canopy", 5], ["flora/tropical-fern", 3]], [62, 124, 129]),
  // The generated water footprint is narrower than the river biome's riparian corridor. Declare
  // ground grass explicitly so dry banks do not become an artificial vegetation void; runtime
  // water coverage remains the authoritative exclusion mask for submerged blades.
  definition("river", "River", "aquatic", ["flowing", "freshwater"], [-2, 34], [0.7, 1], ["ground/river-gravel", "ground/river-silt"], [["flora/forest-grass", 4], ["flora/riparian-reed", 2], ["flora/waterweed", 1]], [52, 132, 157]),
  definition("salt-flat", "Salt Flat", "geological", ["arid", "saline"], [-4, 48], [0, 0.2], ["ground/salt-crust", "ground/saline-mud"], [["flora/saltbush", 1]], [126, 153, 158]),
  definition("savanna", "Savanna", "terrestrial", ["grassland", "tropical"], [14, 44], [0.15, 0.65], ["ground/savanna-grass", "ground/red-loam"], [["flora/acacia", 1], ["flora/savanna-grass", 5]], [75, 132, 146]),
  definition("scrubland", "Scrubland", "terrestrial", ["semi-arid", "shrubland"], [-2, 38], [0.1, 0.5], ["ground/scrub-soil", "rock/weathered"], [["flora/scrub-grass", 2], ["flora/scrub-shrub", 4]], [80, 132, 143]),
  definition("swamp", "Swamp", "wetland", ["forest", "freshwater"], [4, 36], [0.8, 1], ["ground/swamp-mud", "ground/wet-duff"], [["flora/bald-cypress", 3], ["flora/swamp-reed", 2]], [66, 115, 105]),
  definition("taiga", "Taiga", "terrestrial", ["cold", "forest"], [-35, 14], [0.25, 0.8], ["ground/taiga-duff", "ground/snow"], [["flora/larch", 2], ["flora/spruce", 5]], [72, 122, 142]),
  definition("temperate-deciduous-forest", "Temperate Deciduous Forest", "terrestrial", ["deciduous", "forest"], [-10, 32], [0.4, 0.9], ["ground/leaf-litter", "ground/forest-loam"],
    [["flora/ash", 2], ["flora/fern", 2], ["flora/forest-grass", 6], ["flora/oak", 4], ["flora/shrub", 1]], [69, 126, 143]),
  definition("temperate-rainforest", "Temperate Rainforest", "terrestrial", ["forest", "wet"], [0, 24], [0.7, 1], ["ground/mossy-duff", "rock/mossy"], [["flora/cedar", 3], ["flora/giant-fern", 2]], [62, 121, 134]),
  definition("tropical-seasonal-forest", "Tropical Seasonal Forest", "terrestrial", ["forest", "seasonal"], [16, 42], [0.35, 0.85], ["ground/seasonal-duff", "ground/red-loam"], [["flora/dry-tropical-tree", 4], ["flora/tropical-grass", 2]], [72, 130, 141]),
  definition("tundra", "Tundra", "terrestrial", ["cold", "treeless"], [-45, 10], [0.1, 0.65], ["ground/permafrost", "ground/tundra-moss", "ground/snow"], [["flora/dwarf-shrub", 2], ["flora/tundra-moss", 5]], [86, 142, 162]),
  definition("volcanic", "Volcanic Highlands", "geological", ["igneous", "mountain"], [-5, 55], [0, 0.75], ["rock/basalt", "ground/volcanic-ash"], [["flora/volcanic-fern", 1]], [91, 111, 112]),
];

export const BIOME_LIBRARY_V1 = parseBiomePack({
  schema: BIOME_PACK_SCHEMA,
  id: "limina-biomes-core",
  version: VERSION,
  definitions,
  legacyAliases: [
    { legacyKind: "blight", biomeId: "blighted-waste" },
    { legacyKind: "desert", biomeId: "desert" },
    { legacyKind: "forest", biomeId: "temperate-deciduous-forest" },
    { legacyKind: "grass", biomeId: "grassland" },
    { legacyKind: "mountain", biomeId: "alpine" },
    { legacyKind: "swamp", biomeId: "swamp" },
    { legacyKind: "tundra", biomeId: "tundra" },
    { legacyKind: "water", biomeId: "ocean" },
  ],
  provenance: { sourceUri: "limina://biomes/v1", licenseId: "CC0-1.0", authoredBy: "Limina Project" },
});
