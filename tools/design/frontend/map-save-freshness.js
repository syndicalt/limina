export function requireCommittedMapSave(result, action = "Build") {
  if (!result || result.ok !== true) {
    const error = new Error(`${action} requires a freshly committed Atlas MapDoc`);
    error.code = result?.conflict === true ? "ATLAS_MAP_SAVE_CONFLICT" : "ATLAS_MAP_SAVE_REQUIRED";
    throw error;
  }
  return result;
}
