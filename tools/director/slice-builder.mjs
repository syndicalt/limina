// HOST-SIDE SliceBuilder — the LIVE seam the coordinator delegates each slice to. It runs the
// per-slice build→gate loop as a real `llmff run` (llmff = the per-stage executor; our coordinator
// owns the spine), and returns the gate verdict + the llmff run status/manifest hash. This finishes
// the coordinator's SliceBuilder: in M4 it was a deterministic injected stand-in; now it is a real
// llmff subprocess that invokes the real limina functional gate and gates on its result.
//
// llmff is used PURELY as the bounded executor (run the real limina gate + validate the JSON verdict
// + trace) — NO inference, no provider, no API key. CODEGEN (writing the slice's game code) is the
// coordinator AGENT's job: the agent IS the LLM, so the flow never reaches outside the agent to an
// external model API. The agent writes the game in its turn, calls this to GATE it, and owns the
// build→revise loop; this returns the verdict + the llmff run status/manifest hash.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** Resolve the llmff binary: LLMFF_BIN env → on PATH → null (caller skips). */
export function resolveLlmff() {
  if (process.env.LLMFF_BIN && existsSync(process.env.LLMFF_BIN)) return process.env.LLMFF_BIN;
  const which = spawnSync("bash", ["-lc", "command -v llmff"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

/**
 * Build + gate ONE slice via `llmff run`. Returns:
 *   { ok, skipped?, reason?, llmffStatus, manifestHash, verdict, passed, runDir, stderr }
 * `opts.broken` points the gate at the broken reference game (for the falsifiability check).
 */
export function buildSliceViaLlmff(slice, opts = {}) {
  const llmff = opts.llmff || resolveLlmff();
  if (!llmff) return { ok: false, skipped: true, reason: "llmff not found (set LLMFF_BIN or install llmff)" };

  const runDir = mkdtempSync(join(tmpdir(), "limina-slice-"));
  writeFileSync(join(runDir, "slice.json"), JSON.stringify(slice, null, 2));

  const gateSh = join(repoRoot, "tools", "director", "run-slice-gate.sh");
  // llmff starts tool commands without PATH resolution → use an absolute bash.
  const bashPath = ["/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) || "/bin/bash";
  const template = readFileSync(join(repoRoot, "tools", "director", "slice-build.yaml"), "utf8");
  const manifestPath = join(runDir, "slice-build.yaml");
  // replaceAll: the placeholders also appear in the manifest's header comment.
  writeFileSync(manifestPath, template.replaceAll("__BASH__", bashPath).replaceAll("__GATE_SH__", gateSh));

  const env = { ...process.env };
  if (opts.broken) env.SLICE_BROKEN = "true";
  if (slice && slice.gameId) env.SLICE_GAME_ID = slice.gameId; // data-driven game selection

  // ABSOLUTE manifest + run-dir: llmff sets tool commands' working dir to the manifest's parent
  // directory, so a bare relative manifest name yields an empty cwd (current_dir("") → ENOENT).
  const res = spawnSync(llmff, ["run", manifestPath, "--run-dir", runDir], {
    cwd: runDir, env, encoding: "utf8", timeout: opts.timeoutMs || 180000,
  });

  const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
  // The gate verdict is the direct pipeline output (no inference/loop wrapper).
  const verdict = readJson(join(runDir, "slice-result.json"));
  const runStatus = readJson(join(runDir, "result.json"));

  return {
    ok: res.status === 0,
    llmffStatus: runStatus && runStatus.status,
    manifestHash: runStatus && runStatus.manifest && runStatus.manifest.hash,
    verdict,
    passed: !!(verdict && verdict.passed === true),
    runDir,
    stderr: res.stderr,
  };
}

/**
 * Host-side coordinator that delegates each gated slice to `llmff run`, halting on the first red
 * slice. `plan` is the Architecture Plan (planFromGDS output) as a plain object; only `slices`
 * (with `id`/`dodIds`) are read here. Returns a ledger mirroring the in-engine coordinator.
 */
export function coordinateViaLlmff(plan, opts = {}) {
  const entries = [];
  for (const slice of plan.slices) {
    if (!slice.dodIds || slice.dodIds.length === 0) {
      entries.push({ sliceId: slice.id, name: slice.name, status: "skipped" });
      continue;
    }
    const r = buildSliceViaLlmff({ sliceId: slice.id, dodIds: slice.dodIds, gameId: slice.gameId }, opts);
    if (r.skipped) return { passed: false, skipped: true, reason: r.reason, entries };
    const status = r.passed ? "passed" : "failed";
    entries.push({ sliceId: slice.id, name: slice.name, status, llmffStatus: r.llmffStatus, verdict: r.verdict });
    if (!r.passed) return { passed: false, entries, haltedAt: slice.id };
  }
  return { passed: entries.every((e) => e.status !== "failed"), entries };
}
