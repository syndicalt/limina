import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LIMINA_PROJECT_SCHEMA = "limina-project/1";
export const MAX_PROJECT_ID_LENGTH = 64;

const CONFIG_FILE = "limina.project.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const ALLOWED_FIELDS = new Set(["schema", "projectId", "assetRoot", "stateDir"]);
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export class ProjectConfigError extends Error {
  constructor(message, options) {
    super(`invalid Limina project: ${message}`, options);
    this.name = "ProjectConfigError";
  }
}

function fail(message, options) {
  throw new ProjectConfigError(message, options);
}

function statPath(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${path}`);
    fail(`cannot inspect ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function duplicateJsonField(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') return JSON.parse(text.slice(start, offset));
    }
    return undefined;
  };
  const value = (path) => {
    whitespace();
    if (text[offset] === "{") return object(path);
    if (text[offset] === "[") return array(path);
    if (text[offset] === '"') { string(); return undefined; }
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset++;
    return undefined;
  };
  const object = (path) => {
    offset++;
    whitespace();
    const fields = new Set();
    if (text[offset] === "}") { offset++; return undefined; }
    while (offset < text.length) {
      whitespace();
      const field = string();
      if (fields.has(field)) return path ? `${path}.${field}` : field;
      fields.add(field);
      whitespace();
      offset++;
      const duplicate = value(path ? `${path}.${field}` : field);
      if (duplicate !== undefined) return duplicate;
      whitespace();
      if (text[offset++] === "}") return undefined;
    }
    return undefined;
  };
  const array = (path) => {
    offset++;
    whitespace();
    if (text[offset] === "]") { offset++; return undefined; }
    let index = 0;
    while (offset < text.length) {
      const duplicate = value(`${path}[${index++}]`);
      if (duplicate !== undefined) return duplicate;
      whitespace();
      if (text[offset++] === "]") return undefined;
    }
    return undefined;
  };
  return value("");
}

function pathIsWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

export function resolveProjectPath(projectRoot, explicitPath, label = "project path") {
  if (typeof projectRoot !== "string" || typeof explicitPath !== "string" || explicitPath.length === 0) {
    fail(`${label} requires a canonical project root and an explicit path`);
  }
  const candidate = resolve(explicitPath);
  if (!pathIsWithin(projectRoot, candidate)) fail(`${label} is outside the explicit project root: ${candidate}`);
  const candidateStat = statPath(candidate, label);
  let resolvedPath;
  try {
    resolvedPath = realpathSync(candidate);
  } catch (error) {
    fail(`cannot resolve ${label} ${candidate}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!pathIsWithin(projectRoot, resolvedPath)) fail(`${label} resolves outside the explicit project root: ${resolvedPath}`);
  if (!candidateStat.isDirectory() && !candidateStat.isSymbolicLink()) fail(`${label} is not a directory: ${candidate}`);
  try {
    if (!lstatSync(resolvedPath).isDirectory()) fail(`${label} is not a directory: ${resolvedPath}`);
  } catch (error) {
    if (error instanceof ProjectConfigError) throw error;
    fail(`cannot inspect ${label} ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return resolvedPath;
}

function validateOptionalDirectory(config, field, configPath, projectRoot) {
  if (!(field in config)) return undefined;
  const value = config[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0") || value.includes("\\") || value.includes(":") || isAbsolute(value)) {
    fail(`${field} in ${configPath} must be a non-empty project-relative path of at most 256 characters`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${field} in ${configPath} must not contain empty, '.' or '..' path segments`);
  }

  const candidate = resolve(projectRoot, ...segments);
  if (!pathIsWithin(projectRoot, candidate) || candidate === projectRoot) {
    fail(`${field} in ${configPath} must stay within the project root`);
  }

  let ancestor = projectRoot;
  for (const segment of segments) {
    ancestor = join(ancestor, segment);
    try {
      lstatSync(ancestor);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      fail(`cannot inspect ${field} path ${ancestor}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let resolvedAncestor;
    try {
      resolvedAncestor = realpathSync(ancestor);
    } catch (error) {
      fail(`cannot resolve ${field} path ${ancestor}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!pathIsWithin(projectRoot, resolvedAncestor)) {
      fail(`${field} in ${configPath} resolves outside the project root through ${ancestor}`);
    }
    ancestor = resolvedAncestor;
  }
  return value;
}

/**
 * Load the sole project-identity authority from an explicit project root.
 * No package name, working-directory name, or environment fallback is allowed.
 */
export function loadProjectConfig(explicitProjectRoot) {
  if (typeof explicitProjectRoot !== "string" || explicitProjectRoot.length === 0) {
    fail("an explicit project root is required");
  }

  const requestedRoot = resolve(explicitProjectRoot);
  const rootStat = statPath(requestedRoot, "project root");
  if (rootStat.isSymbolicLink()) fail(`project root must be an explicit directory, not a symbolic link: ${requestedRoot}`);
  if (!rootStat.isDirectory()) fail(`project root is not a directory: ${requestedRoot}`);

  let projectRoot;
  try {
    projectRoot = realpathSync(requestedRoot);
  } catch (error) {
    fail(`cannot resolve project root ${requestedRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const configPath = join(projectRoot, CONFIG_FILE);
  const configStat = statPath(configPath, CONFIG_FILE);
  if (configStat.isSymbolicLink()) fail(`${configPath} must be a regular file, not a symbolic link`);
  if (!configStat.isFile()) fail(`${configPath} must be a regular file`);
  if (configStat.size > MAX_CONFIG_BYTES) fail(`${configPath} exceeds the ${MAX_CONFIG_BYTES}-byte limit`);

  let resolvedConfigPath;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch (error) {
    fail(`cannot resolve ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (dirname(resolvedConfigPath) !== projectRoot) {
    fail(`${CONFIG_FILE} resolves outside the explicit project root: ${resolvedConfigPath}`);
  }

  let descriptor;
  try {
    descriptor = openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`cannot open ${configPath} without following links: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let source;
  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile() || openedStat.dev !== configStat.dev || openedStat.ino !== configStat.ino) {
      fail(`${configPath} changed while it was being validated`);
    }
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof ProjectConfigError) throw error;
    fail(`cannot read ${resolvedConfigPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    closeSync(descriptor);
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    fail(`${resolvedConfigPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const duplicate = duplicateJsonField(source);
  if (duplicate !== undefined) fail(`${resolvedConfigPath} contains duplicate field "${duplicate}"`);
  if (config === null || Array.isArray(config) || typeof config !== "object") {
    fail(`${resolvedConfigPath} must contain one JSON object`);
  }

  const extraFields = Object.keys(config).filter((field) => !ALLOWED_FIELDS.has(field));
  if (extraFields.length > 0) {
    fail(`${resolvedConfigPath} contains unsupported field(s): ${extraFields.join(", ")}; allowed fields are schema, projectId, assetRoot, stateDir`);
  }
  if (config.schema !== LIMINA_PROJECT_SCHEMA) {
    fail(`${resolvedConfigPath} schema must be exactly "${LIMINA_PROJECT_SCHEMA}"`);
  }
  if (typeof config.projectId !== "string" || config.projectId.length > MAX_PROJECT_ID_LENGTH || !PROJECT_ID_PATTERN.test(config.projectId)) {
    fail(`${resolvedConfigPath} projectId must be 1-${MAX_PROJECT_ID_LENGTH} lowercase characters, start with a letter or digit, and contain only a-z, 0-9, '.', '_' or '-'`);
  }

  const assetRoot = validateOptionalDirectory(config, "assetRoot", resolvedConfigPath, projectRoot);
  const stateDir = validateOptionalDirectory(config, "stateDir", resolvedConfigPath, projectRoot);
  return Object.freeze({
    schema: LIMINA_PROJECT_SCHEMA,
    projectId: config.projectId,
    ...(assetRoot === undefined ? {} : { assetRoot }),
    ...(stateDir === undefined ? {} : { stateDir }),
    projectRoot,
    configPath: resolvedConfigPath,
  });
}
