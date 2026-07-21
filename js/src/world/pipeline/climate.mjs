// PIPELINE STAGE 4 — CLIMATE. A pure model that reads climate params and MODIFIES world state: it
// tells the vegetation stage WHAT grows (conifer/deciduous mix), its STATE (green/autumn/bare), how
// MUCH (density), and the tree line (snow); and it tells water whether it's frozen. Same mechanism
// acts on vegetation + water. Pure/deterministic — no side effects, just resolved parameters.

export function resolveClimate(c = {}) {
  const season = c.season ?? "autumn";
  const tempC = c.temperatureC ?? 12;
  const moisture01 = c.moisture01 ?? 0.6;
  const frozen = tempC <= 0 || (season === "winter" && tempC < 4);
  const cold = tempC < 7;
  // colder → more conifers, lower density, lower tree line (snow starts sooner)
  const coniferShare = cold ? 0.82 : 0.55;
  const density01 = Math.max(0.15, Math.min(1, moisture01 * (cold ? 0.7 : 1.0)));
  const treeLineFrac = cold ? 0.58 : 0.76; // fraction of terrain amplitude above which trees stop
  // deciduous foliage STATE from season
  const deciduousState = season === "winter" ? "bare" : season === "autumn" ? "autumn" : "green";
  const autumnTints = [0xd9a233, 0xc46a1f, 0x9c4a1a, 0xb5842a, 0xcf8f2a];
  return { frozen, coniferShare, density01, treeLineFrac, deciduousState, autumnTints, season, tempC, moisture01 };
}
