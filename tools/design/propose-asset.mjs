#!/usr/bin/env node
// propose-asset.mjs <assetId> <qcRender> <x> <z> — import a QC'd asset THROUGH the
// approval queue (builder.review profile: the placement is HELD for a reviewer).
// Auth comes from LIMINA_EDITOR_TOKEN or the launcher's private capability file
// (see tools/bridge/editor-client.mjs) — never from a pasted console token.

import {
  EditorBridgeClient,
  editorClientConfigFromEnvironment,
} from "../bridge/editor-client.mjs";

const [assetId, qcRender, x, z] = process.argv.slice(2);
if (typeof assetId !== "string" || assetId.length === 0) {
  console.error("usage: propose-asset.mjs <assetId> <qcRender> <x> <z>");
  process.exit(2);
}
const px = Number(x);
const pz = Number(z);
if (!Number.isFinite(px) || !Number.isFinite(pz)) {
  console.error(`propose-asset: x/z must be finite numbers, got '${x}' '${z}'`);
  process.exit(2);
}

const client = new EditorBridgeClient(
  editorClientConfigFromEnvironment(process.env, { agentId: "qc-reviewer", profile: "builder.review" }),
);

try {
  await client.callTool("asset.place", {
    assetId,
    position: [px, 0, pz],
    ground: true,
    qcRender,
    qcChecks: { textured: true, scale: true, integrity: true, theme: null },
  });
  console.log(`placed ${assetId} at [${px}, 0, ${pz}]`);
} catch (error) {
  // A held proposal is the intended outcome for this profile, not a failure.
  const code = error?.data?.error?.code;
  if (code === "pending_approval") {
    console.log(`HELD for approval: ${error.data.error.message}`);
  } else {
    console.error(`propose failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  client.close();
}
