// packageForPlatform — the platform-distributable layer (Track E shipping).
//
// Phase-8 assembleExport produces a portable world bundle {manifest.json, log.jsonl,
// keyframes.jsonl, …}. Shipping it to a concrete platform (a browser build, a desktop app, a mobile
// app) needs one more step: GATE the bundle on integrity + replay-equivalence, then emit a
// platform-targeted PACKAGE DESCRIPTOR — the runtime entry, the world's content address, and the
// file set with roles — that a platform build toolchain consumes to produce the actual installable.
//
// This is the packaging LOGIC, and it is deterministic + testable headlessly: it refuses to package
// a corrupt world, content-addresses the world by the host sha256 of its log, and produces a stable
// descriptor per platform. The native build itself (compiling a desktop/mobile binary that embeds
// the runtime + bundle) is the environment-bound step that reads this descriptor.

import type { EngineOps } from "../engine.ts";
import { verifyWorldLog } from "../worldlog/verify.ts";

export type Platform = "browser" | "desktop" | "mobile";

const PLATFORM_ENTRY: Record<Platform, string> = {
  browser: "index.html",
  desktop: "limina-runtime",
  mobile: "limina-mobile",
};

export interface PackageFile {
  name: string;
  role: "manifest" | "log" | "keyframes" | "assets" | "tiles";
  bytes: number;
}

export interface PlatformPackage {
  format: "limina-platform-package@1";
  platform: Platform;
  runtime: string;
  worldId: string;
  commandCount: number;
  /** Content address of the world (host sha256 of log.jsonl) — the same world hashes identically
   *  on every platform, so a desktop and browser build of one world share this address. */
  contentHash: string;
  entry: string;
  files: PackageFile[];
}

export interface PackageResult {
  ok: boolean;
  package?: PlatformPackage;
  reason?: string;
}

export interface ExportFileSet {
  "manifest.json": string;
  "log.jsonl": string;
  "keyframes.jsonl"?: string;
  "assets.jsonl"?: string;
  "tiles.jsonl"?: string;
}

const byteLen = (s: string | undefined): number => (s === undefined ? 0 : s.length);

/** Gate an export bundle and emit a platform package descriptor. Refuses (ok:false, reason) when the
 *  world log fails structural integrity — a corrupt world is never packaged for ship. */
export function packageForPlatform(
  files: ExportFileSet,
  opts: { platform: Platform; runtime: string; ops?: EngineOps },
): PackageResult {
  const log = files["log.jsonl"];
  if (typeof log !== "string" || log.length === 0) return { ok: false, reason: "missing log.jsonl" };

  // SHIP GATE: structural integrity of the world log (truncation / dup-seq / unknown kind / …).
  const integrity = verifyWorldLog(log);
  if (!integrity.ok) return { ok: false, reason: `integrity: ${integrity.reason}` };

  // World identity from the manifest (tolerant of field naming), content-addressed by the log.
  let worldId = "unknown";
  try {
    const manifest = JSON.parse(files["manifest.json"]) as { id?: string; worldId?: string };
    worldId = manifest.id ?? manifest.worldId ?? "unknown";
  } catch {
    return { ok: false, reason: "invalid manifest.json (not JSON)" };
  }

  const contentHash = opts.ops !== undefined ? "sha256:" + opts.ops.op_sha256(log) : "sha256:";

  const fileList: PackageFile[] = [
    { name: "manifest.json", role: "manifest", bytes: byteLen(files["manifest.json"]) },
    { name: "log.jsonl", role: "log", bytes: byteLen(log) },
    { name: "keyframes.jsonl", role: "keyframes", bytes: byteLen(files["keyframes.jsonl"]) },
  ];
  if (files["assets.jsonl"] !== undefined) fileList.push({ name: "assets.jsonl", role: "assets", bytes: byteLen(files["assets.jsonl"]) });
  if (files["tiles.jsonl"] !== undefined) fileList.push({ name: "tiles.jsonl", role: "tiles", bytes: byteLen(files["tiles.jsonl"]) });

  return {
    ok: true,
    package: {
      format: "limina-platform-package@1",
      platform: opts.platform,
      runtime: opts.runtime,
      worldId,
      commandCount: integrity.commandCount,
      contentHash,
      entry: PLATFORM_ENTRY[opts.platform],
      files: fileList,
    },
  };
}
