#!/usr/bin/env node
// Compile a project's design vault into an immutable project-local WorldMap,
// preflight a deterministic build plan, and author that plan into a clean editor.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultEditorCapabilityPath,
  readEditorCapability,
} from "../bridge/editor-client.mjs";
import { compileDesignMap } from "../../js/src/world/design-map-compile.mjs";
import { parseAtlasDesignRef } from "../../js/src/world/design-ref.mjs";
import {
  DEFAULT_MAP_EROSION_RECIPE,
  NO_EROSION_RECIPE,
  validateErosionRecipe,
} from "../../js/src/world/pipeline/erosion.mjs";
import { loadProjectConfig, resolveProjectPath } from "../project-config.mjs";

function projectRootForVault(vaultDir) {
  return basename(vaultDir) === "design" ? dirname(vaultDir) : vaultDir;
}

export function loadBuildProjectConfig(vaultDir) {
  const config = loadProjectConfig(projectRootForVault(resolve(vaultDir)));
  return Object.freeze({ ...config, vaultDir: resolveProjectPath(config.projectRoot, vaultDir, "design vault") });
}

function projectAssetPath(projectRoot, assetId) {
  if (typeof assetId !== "string" || assetId.length === 0 || assetId.includes("\0")) {
    throw new Error("asset id must be a non-empty relative path");
  }
  const assetRoot = resolve(projectRoot, "assets");
  const candidate = resolve(assetRoot, assetId);
  const relativePath = relative(assetRoot, candidate);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`asset id escapes the project asset root: ${assetId}`);
  }
  return candidate;
}

function compileProjectMap(vaultDir, mapId, projectRoot) {
  const mapsJsonText = readFileSync(join(vaultDir, "maps.json"), "utf8");
  const worldBibleText = readFileSync(join(vaultDir, "world-bible.md"), "utf8");
  const placesPath = join(vaultDir, "places.md");
  const placesText = existsSync(placesPath) ? readFileSync(placesPath, "utf8") : undefined;
  const { worldMap, warnings } = compileDesignMap({ mapsJsonText, worldBibleText, placesText, mapId });
  const mapAssetId = `maps/${worldMap.id}/${worldMap.provenance.contentHash}.worldmap.json`;
  const output = join(projectRoot, "assets", ...mapAssetId.split("/"));
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(worldMap, null, 2) + "\n", "utf8");
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { projectRoot, worldMap, mapAssetId, warnings };
}

function worldPoint(worldMap, point) {
  return [
    worldMap.origin[0] + point[0] * worldMap.unitsPerMeter,
    worldMap.origin[1] + point[1] * worldMap.unitsPerMeter,
  ];
}

function mapBounds(worldMap) {
  const points = [];
  for (const polygon of worldMap.land) points.push(...polygon.points);
  for (const biome of worldMap.biomes) points.push(...biome.points);
  for (const waterway of worldMap.waterways) points.push(...waterway.points);
  for (const route of worldMap.routes) points.push(...route.points);
  for (const anchor of worldMap.anchors) points.push(anchor.position);
  for (const place of worldMap.gazetteer ?? []) points.push(place.position);
  if (points.length === 0) throw new Error("compiled map has no spatial content");
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    const [x, z] = worldPoint(worldMap, point);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error("compiled map contains a non-finite coordinate");
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ, width: maxX - minX, height: maxZ - minZ };
}

function inclusionDiscs(worldMap, biomeName, span) {
  const step = Math.max(18, Math.round(span * 0.02));
  const discs = [];
  const inside = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const region of worldMap.biomes.filter((biome) => biome.biome === biomeName)) {
    const ring = region.points.map((point) => worldPoint(worldMap, point));
    const xs = ring.map((point) => point[0]), zs = ring.map((point) => point[1]);
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += step) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
        if (inside(x, z, ring)) discs.push({ x: Math.round(x), z: Math.round(z), r: Math.round(step * 0.72) });
      }
    }
  }
  return discs;
}

function vegetationInput(projectRoot, worldMap, terrainRef, span, seed, exclusions) {
  const forest = inclusionDiscs(worldMap, "forest", span);
  if (forest.length === 0) return undefined;
  const treePackPath = join(projectRoot, "assets", "tree-pack.json");
  if (existsSync(treePackPath)) {
    const pack = JSON.parse(readFileSync(treePackPath, "utf8"));
    const species = ["pine", "spruce", "birch"].filter((name) => Array.isArray(pack[name]) && pack[name].length > 0);
    if (species.length > 0) {
      for (const name of species) for (const item of pack[name]) {
        if (!item?.id || !existsSync(projectAssetPath(projectRoot, item.id))) throw new Error(`tree pack references missing asset: ${item?.id}`);
      }
      return { terrain: terrainRef, species, density: Math.min(192, Math.max(32, Math.round(span / 8))), coverage: 0.82,
        cluster: 0.5, seed, slopeMax: 1.4, elevationMin: (worldMap.seaLevel ?? 0) + 0.5, inclusions: forest, exclusions };
    }
  }
  const fallback = "pine.glb";
  if (!existsSync(projectAssetPath(projectRoot, fallback))) return undefined;
  return { terrain: terrainRef, assets: [{ id: fallback }], density: Math.min(192, Math.max(32, Math.round(span / 8))),
    coverage: 0.82, cluster: 0.5, seed, slopeMax: 1.4, elevationMin: (worldMap.seaLevel ?? 0) + 0.5,
    inclusions: forest, exclusions };
}

export function planWorldBuild({
  projectRoot,
  worldMap,
  mapAssetId,
  seed = 11,
  erosionRecipe = DEFAULT_MAP_EROSION_RECIPE,
}) {
  if (!Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error(`world build seed must be a signed 32-bit integer, got ${seed}`);
  }
  const erosion = validateErosionRecipe(erosionRecipe);
  const bounds = mapBounds(worldMap);
  const span = Math.max(bounds.width, bounds.height, 100);
  const size = Math.ceil((span * 1.25) / 50) * 50;
  if (size > 8192) throw new Error(`map requires a ${size}m terrain, above the single-terrain 8192m cap; use streamed regions`);
  const center = [(bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2];
  const approximateResolution = Math.min(257, Math.max(129, Math.ceil(size / 24)));
  const resolution = approximateResolution % 2 === 0 ? Math.min(513, approximateResolution + 1) : approximateResolution;
  const terrainRef = "$terrain";
  const commands = [
    { tool: "terrain.create", input: { size, resolution, origin: center, color: 0x5a713a,
      generate: {
        source: "map",
        mapAssetId,
        seed,
        amplitude: Math.max(12, Math.round(span * 0.03)),
        erosion,
      } }, capture: "terrain" },
    { tool: "world.addWater", input: { terrainEntity: terrainRef, level: worldMap.seaLevel ?? 0, size: Math.round(size * 4), color: 0x2b5d72 } },
    { tool: "gazetteer.load", input: { mapAssetId } },
  ];
  for (const waterway of worldMap.waterways) {
    commands.push({ tool: "world.addRiver", input: {
      points: waterway.points.map((point) => worldPoint(worldMap, point)),
      widthM: Math.max(4, (waterway.widthM ?? 6) * 1.7), color: 0x2b5d72,
    } });
  }
  const exclusions = [];
  for (const anchor of worldMap.anchors.filter((candidate) => candidate.kind === "asset")) {
    if (typeof anchor.assetId !== "string" || anchor.assetId.length === 0) throw new Error(`asset anchor ${anchor.id} has no assetId`);
    if (!existsSync(projectAssetPath(projectRoot, anchor.assetId))) throw new Error(`asset anchor ${anchor.id} references missing ${anchor.assetId}`);
    const [x, z] = worldPoint(worldMap, anchor.position);
    const scale = anchor.scale ?? 1;
    const designRef = anchor.designRef === undefined ? undefined : parseAtlasDesignRef(anchor.designRef);
    commands.push({ tool: "asset.place", input: { assetId: anchor.assetId, position: [x, 0, z], rotation: [0, anchor.rot ?? 0, 0],
      scale: [scale, scale, scale], ground: true, ...(designRef === undefined ? {} : { designRef }) } });
    exclusions.push({ x, z, r: Math.max(10, 12 * scale) });
  }
  const vegetation = vegetationInput(projectRoot, worldMap, terrainRef, span, seed, exclusions);
  if (vegetation !== undefined) commands.push({ tool: "vegetation.scatter", input: vegetation });
  return { commands, bounds, size, resolution, center, span };
}

function resolveReferences(value, captures) {
  if (value === "$terrain") return captures.terrain;
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, captures));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, captures)]));
  return value;
}

async function authorPlan({ url, token, project, plan }) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const rpc = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`${method} timed out`)); }, 90_000);
    pending.set(id, { resolveRequest, rejectRequest, timeout });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  ws.addEventListener("message", (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.rejectRequest(new Error(JSON.stringify(message.error)));
    else request.resolveRequest(message.result);
  });
  await new Promise((resolveOpen, rejectOpen) => { ws.addEventListener("open", resolveOpen, { once: true }); ws.addEventListener("error", rejectOpen, { once: true }); });
  try {
    await rpc("initialize", { agentId: "design-build", sessionId: `design-build-${project}`, profile: "builder.readWrite", authToken: token });
    const tail = await rpc("tools/call", { name: "worldlog.tail", arguments: { since: 0 } });
    const existing = tail?.result?.commands ?? tail?.commands ?? [];
    if (existing.some((command) => command.kind === "skill") && process.env.LIMINA_BUILD_ALLOW_NONEMPTY !== "1") {
      throw new Error("editor world is not empty; refusing to layer another build (archive/reset it, or set LIMINA_BUILD_ALLOW_NONEMPTY=1 explicitly)");
    }
    const captures = {};
    for (const command of plan.commands) {
      const input = resolveReferences(command.input, captures);
      const response = await rpc("tools/call", { name: command.tool, arguments: input });
      if (response?.success === false) throw new Error(`${command.tool} failed: ${JSON.stringify(response.error)}`);
      const result = response?.result ?? response;
      if (command.capture === "terrain") captures.terrain = result?.entity;
      if (command.capture && !captures[command.capture]) throw new Error(`${command.tool} did not return capture ${command.capture}`);
      console.log(`  ok ${command.tool}`);
    }
  } finally {
    ws.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let token = process.env.LIMINA_EDITOR_TOKEN;
  let vault = process.env.LIMINA_VAULT_DIR;
  for (const arg of args) {
    if (arg.includes("/") || arg === ".") vault = resolve(arg);
    else if (!token) token = arg;
  }
  if (!vault) {
    const candidate = resolve(process.cwd(), "design");
    if (existsSync(join(candidate, "maps.json"))) vault = candidate;
  }
  if (!vault || !existsSync(join(vault, "maps.json"))) throw new Error("design vault not found; pass its directory or run from a project with design/maps.json");
  // Token resolution order: LIMINA_EDITOR_TOKEN, positional arg, then the
  // launcher's private capability file (LIMINA_EDITOR_CAPABILITY overrides its path).
  if (!token) {
    const capability = readEditorCapability(process.env.LIMINA_EDITOR_CAPABILITY ?? defaultEditorCapabilityPath());
    token = capability.token;
  }
  const projectConfig = loadBuildProjectConfig(vault);
  vault = projectConfig.vaultDir;
  const compiled = compileProjectMap(vault, process.env.LIMINA_MAP_ID, projectConfig.projectRoot);
  const project = projectConfig.projectId;
  for (const warning of compiled.warnings) console.warn(`warning: ${warning}`);
  const seed = Number(process.env.LIMINA_BUILD_SEED ?? 11);
  if (!Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error(`LIMINA_BUILD_SEED must be a signed 32-bit integer, got ${process.env.LIMINA_BUILD_SEED}`);
  }
  const erosionMode = process.env.LIMINA_BUILD_EROSION ?? "canonical";
  if (erosionMode !== "canonical" && erosionMode !== "disabled") {
    throw new Error(`LIMINA_BUILD_EROSION must be 'canonical' or 'disabled', got '${erosionMode}'`);
  }
  const erosionRecipe = erosionMode === "disabled" ? NO_EROSION_RECIPE : DEFAULT_MAP_EROSION_RECIPE;
  const plan = planWorldBuild({ ...compiled, seed, erosionRecipe });
  console.log(`compiled ${compiled.mapAssetId} (${plan.size}m terrain, ${plan.commands.length} commands)`);
  await authorPlan({ url: process.env.LIMINA_EDITOR_URL || "ws://localhost:8787/", token, project, plan });
  console.log(`built ${project} from ${compiled.mapAssetId}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main().catch((error) => { console.error(`build failed: ${error.message}`); process.exit(1); });
