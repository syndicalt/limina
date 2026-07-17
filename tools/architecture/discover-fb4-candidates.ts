import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBuildingReviewState, verifyBuildingReviewLedger } from "../../js/src/assets/building-review-outcome.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CANDIDATE_ROOT = resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4");
const OUTCOME_ROOT = resolve(CANDIDATE_ROOT, "review-outcomes");

export async function discoverFb4Candidates(root = CANDIDATE_ROOT) {
  const outcomeRoot = root === CANDIDATE_ROOT ? OUTCOME_ROOT : resolve(root, "review-outcomes");
  const outcomeNames = await readdir(outcomeRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records = await Promise.all(outcomeNames.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    const path=resolve(outcomeRoot,name);return Object.freeze({path:path.slice(ROOT.length+1).replaceAll("\\","/"),bytes:await readFile(path)});
  }));
  const outcomes = verifyBuildingReviewLedger(records, (path) => readFileSync(resolve(ROOT,path)));
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()
    && /^fb4-multi-room-candidate-[0-9a-f]{12}$/.test(entry.name)).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => {
    const manifest = JSON.parse(await readFile(resolve(root, name, "candidate-manifest.json"), "utf8"));
    return Object.freeze({ directory: name, ...resolveBuildingReviewState(manifest, outcomes) });
  }));
}

if (import.meta.main) console.log(JSON.stringify(await discoverFb4Candidates(), null, 2));
