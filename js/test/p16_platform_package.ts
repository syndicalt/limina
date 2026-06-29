// Phase 16 (Track E — Ship) — THE PLATFORM-PACKAGING GATE.
//
// packageForPlatform takes a portable world bundle and emits a platform-targeted package descriptor
// the build toolchain consumes — AFTER gating the world on integrity. This gate proves: a genuine
// bundle packages for each platform with the right runtime entry and a content address; the SAME
// world content-addresses identically across platforms; a corrupt world is REFUSED (never shipped);
// asset/tile files are carried with roles; and packaging is deterministic.
//
// (The native build itself — compiling a desktop/mobile installable that embeds the runtime + bundle
// — is the environment-bound step that reads this descriptor; the packaging LOGIC is tested here.)
//
// Run: ./target/release/limina js/test/p16_platform_package.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { packageForPlatform, type Platform, type ExportFileSet } from "../src/export/platform_package.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_platform_package FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
const PERMS = resolveProfile("builder.readWrite");

// ── Build a genuine export file set (a real recorded log + a manifest + empty keyframes). ─────
ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p16_pkg"));
registerCoreSkills(reg);
const recorder = new WorldRecorder("ses_p16_pkg");
recorder.attach(reg);
const world = makeWorld(ops);
const base: InvokeBase = { agentId: "agt", sessionId: "ses_p16_pkg", permissions: PERMS, tick: 0, world };
for (const x of [0, 4, 8]) await reg.invoke("scene.createEntity", { shape: "box", position: [x, 0, 0] }, base);
const log = recorder.toJsonl();
const manifest = JSON.stringify({ version: 1, id: "the-last-watch", commands: recorder.commands.length });
const files: ExportFileSet = { "manifest.json": manifest, "log.jsonl": log, "keyframes.jsonl": "" };

// ── 1. A genuine bundle packages for every platform with the right entry + content address. ───
const PLATFORMS: { platform: Platform; entry: string }[] = [
  { platform: "browser", entry: "index.html" },
  { platform: "desktop", entry: "limina-runtime" },
  { platform: "mobile", entry: "limina-mobile" },
];
const hashes: string[] = [];
for (const { platform, entry } of PLATFORMS) {
  const r = packageForPlatform(files, { platform, runtime: "limina@0.1", ops });
  assert(r.ok && r.package !== undefined, `packages for ${platform} (reason=${r.reason})`);
  const p = r.package;
  assert(p.platform === platform && p.entry === entry, `${platform} gets entry ${entry} (got ${p.entry})`);
  assert(p.worldId === "the-last-watch", `world id carried from the manifest (got ${p.worldId})`);
  assert(p.commandCount === recorder.commands.length, `command count matches the log (got ${p.commandCount})`);
  assert(p.contentHash.startsWith("sha256:"), `the world is content-addressed (got ${p.contentHash})`);
  const roles = p.files.map((f) => f.role);
  assert(roles.includes("manifest") && roles.includes("log") && roles.includes("keyframes"), "the package carries the bundle files with roles");
  hashes.push(p.contentHash);
}

// ── 2. The SAME world content-addresses identically across platforms (one identity, many targets).
assert(hashes.every((h) => h === hashes[0]), `one world → one content hash across platforms (${hashes.join(" ")})`);

// ── 3. A corrupt world is REFUSED (never packaged for ship). ──────────────────────────────────
{
  const lines = log.replace(/\n+$/, "").split("\n");
  const truncated = lines.slice(0, -1).join("\n") + "\n"; // manifest count now mismatches the log
  const r = packageForPlatform({ "manifest.json": manifest, "log.jsonl": truncated, "keyframes.jsonl": "" }, { platform: "desktop", runtime: "limina@0.1", ops });
  assert(!r.ok && /integrity/.test(String(r.reason)), `a corrupt world is refused with an integrity reason (got: ${r.reason})`);
}

// ── 4. Asset/tile files are carried with their roles. ─────────────────────────────────────────
{
  const withAssets: ExportFileSet = { ...files, "assets.jsonl": "{}\n", "tiles.jsonl": "{}\n" };
  const r = packageForPlatform(withAssets, { platform: "desktop", runtime: "limina@0.1", ops });
  assert(r.ok, "packages with assets + tiles");
  const roles = r.package!.files.map((f) => f.role);
  assert(roles.includes("assets") && roles.includes("tiles"), "assets and tiles ride the package with their roles");
}

// ── 5. Deterministic: same input ⇒ identical descriptor. ──────────────────────────────────────
{
  const a = packageForPlatform(files, { platform: "desktop", runtime: "limina@0.1", ops });
  const b = packageForPlatform(files, { platform: "desktop", runtime: "limina@0.1", ops });
  assert(JSON.stringify(a.package) === JSON.stringify(b.package), "packaging is deterministic");
}

ops.op_log(
  "p16_platform_package OK: platform packaging — a genuine world bundle gates on integrity then packages for " +
  "browser/desktop/mobile with the right runtime entry and a sha256 content address; one world hashes identically " +
  "across platforms; a corrupt world is REFUSED with an integrity reason; assets/tiles ride with roles; packaging is " +
  "deterministic. The build toolchain consumes this descriptor to produce the installable.",
);
