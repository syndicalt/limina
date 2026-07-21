#!/usr/bin/env node
import { fetchPolyHavenMaterial } from "./fetch-polyhaven.mjs";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--help") || value("--asset") === undefined) {
  console.error("usage: node material/fetch-polyhaven-cli.mjs --asset <poly-haven-id> [--name <material-name>] [--output-root assets/materials]");
  process.exit(args.includes("--help") ? 0 : 2);
}
console.log(JSON.stringify(await fetchPolyHavenMaterial({ assetId: value("--asset"), name: value("--name"), outputRoot: value("--output-root") }), null, 2));
