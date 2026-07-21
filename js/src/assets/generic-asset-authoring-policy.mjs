export const GENERIC_ASSET_AUTHORING_CATEGORY = "prop";

export function assertGenericAssetAuthoringCategory(category, operation = "generic asset authoring") {
  if (category !== GENERIC_ASSET_AUTHORING_CATEGORY) {
    throw new Error(`${operation} is prop-only; enterable dwelling/civic/military/religious buildings must use BuildingProgram, the architecture compiler, building.placeFunctional, exact review closure, and HITL`);
  }
  return category;
}
