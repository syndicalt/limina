export const ATLAS_WORKSPACE_STORAGE_KEY = "limina.editor.atlas-workspace/v1";
export const ATLAS_WORKSPACE_MIN_WIDTH_PX = 360;
export const ATLAS_WORKSPACE_MIN_VIEWPORT_PX = 360;
export const ATLAS_WORKSPACE_COMPACT_WIDTH_PX = 760;
export const ATLAS_WORKSPACE_DEFAULT_WIDTH_PX = 560;

const DEFAULT_STATE = Object.freeze({ version: 1, open: false, maximized: false, widthPx: ATLAS_WORKSPACE_DEFAULT_WIDTH_PX });

function parseRecord(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object"
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) {
    throw new TypeError("Atlas workspace state must be a plain object");
  }
  const names = Object.getOwnPropertyNames(input).sort();
  if (names.join(",") !== "maximized,open,version,widthPx") {
    throw new TypeError("Atlas workspace state fields are invalid");
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`Atlas workspace state.${name} must be an enumerable data field`);
    }
  }
  return input;
}

export function parseAtlasWorkspaceState(input) {
  const record = parseRecord(input);
  if (record.version !== 1 || typeof record.open !== "boolean" || typeof record.maximized !== "boolean"
      || !Number.isSafeInteger(record.widthPx) || record.widthPx < ATLAS_WORKSPACE_MIN_WIDTH_PX
      || record.widthPx > 10_000) {
    throw new TypeError("Atlas workspace state values are invalid");
  }
  return Object.freeze({ version: 1, open: record.open, maximized: record.maximized, widthPx: record.widthPx });
}

export function defaultAtlasWorkspaceState() {
  return DEFAULT_STATE;
}

export function readAtlasWorkspaceState(storage) {
  try {
    const serialized = storage?.getItem?.(ATLAS_WORKSPACE_STORAGE_KEY);
    if (typeof serialized !== "string") return DEFAULT_STATE;
    return parseAtlasWorkspaceState(JSON.parse(serialized));
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeAtlasWorkspaceState(storage, input) {
  const state = parseAtlasWorkspaceState(input);
  try {
    storage?.setItem?.(ATLAS_WORKSPACE_STORAGE_KEY, JSON.stringify(state));
    return typeof storage?.setItem === "function";
  } catch {
    return false;
  }
}

export function atlasWorkspaceWidthBounds(containerWidth) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return Object.freeze({ minimum: ATLAS_WORKSPACE_MIN_WIDTH_PX, maximum: ATLAS_WORKSPACE_MIN_WIDTH_PX });
  }
  const maximum = Math.max(ATLAS_WORKSPACE_MIN_WIDTH_PX, Math.floor(containerWidth) - ATLAS_WORKSPACE_MIN_VIEWPORT_PX);
  return Object.freeze({ minimum: ATLAS_WORKSPACE_MIN_WIDTH_PX, maximum });
}

export function clampAtlasWorkspaceWidth(widthPx, containerWidth) {
  const { minimum, maximum } = atlasWorkspaceWidthBounds(containerWidth);
  const width = Number.isFinite(widthPx) ? Math.round(widthPx) : ATLAS_WORKSPACE_DEFAULT_WIDTH_PX;
  return Math.min(maximum, Math.max(minimum, width));
}
