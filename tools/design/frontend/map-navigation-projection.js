const PLACE_FIELDS = ["id", "name", "kind", "parentId", "position", "binding", "radiusM", "regionId", "map", "tags", "note", "assetId", "mapLink"];
const MARKER_FIELDS = ["id", "name", "kind", "count", "radiusM", "assetId", "map", "mapLink", "region", "regionId", "tags", "note"];

function copyFields(source, fields) {
  const output = {};
  for (const field of fields) if (source[field] !== undefined) output[field] = source[field];
  return output;
}

function assignedMapId(subject, primaryMapId) {
  if (subject.map === "__off__") return undefined;
  return typeof subject.map === "string" && subject.map.length > 0 ? subject.map : primaryMapId;
}

/** Build the source-fenced navigation projection persisted inside the canonical MapDoc. */
export function projectNavigationSubjects(mapsInput, placesInput, markersInput) {
  const maps = Array.isArray(mapsInput) ? mapsInput : [];
  if (maps.length === 0) return [];
  const primaryMapId = maps[0].id;
  const places = Array.isArray(placesInput) ? placesInput : [];
  const markers = Array.isArray(markersInput) ? markersInput : [];
  const placesById = new Map(places.map((place) => [place.id, place]));

  return maps.map((map) => {
    const includedPlaceIds = new Set();
    for (const place of places) {
      if (!Array.isArray(place.position) || assignedMapId(place, primaryMapId) !== map.id) continue;
      let current = place;
      while (current && !includedPlaceIds.has(current.id)) {
        includedPlaceIds.add(current.id);
        current = current.parentId == null ? undefined : placesById.get(current.parentId);
      }
    }
    const projectedPlaces = places
      .filter((place) => includedPlaceIds.has(place.id))
      .map((place) => {
        const projected = { ...copyFields(place, PLACE_FIELDS), map: map.id };
        // An ancestor assigned elsewhere is structural context on this map, not a second POI.
        if (assignedMapId(place, primaryMapId) !== map.id) {
          delete projected.position;
          delete projected.binding;
          delete projected.radiusM;
          delete projected.assetId;
        }
        return projected;
      });
    const projectedMarkers = markers
      .filter((marker) => assignedMapId(marker, primaryMapId) === map.id)
      .map((marker) => {
        const position = Array.isArray(marker.position)
          ? marker.position
          : (Number.isFinite(marker.x) && Number.isFinite(marker.z) ? [marker.x, marker.z] : undefined);
        return { ...copyFields(marker, MARKER_FIELDS), map: map.id, ...(position === undefined ? {} : { position }) };
      })
      .filter((marker) => Array.isArray(marker.position));
    const next = { ...map };
    if (projectedPlaces.length > 0) next.places = projectedPlaces;
    else delete next.places;
    if (projectedMarkers.length > 0) next.markers = projectedMarkers;
    else delete next.markers;
    return next;
  });
}
