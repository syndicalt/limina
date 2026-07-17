const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/viewport.js"), "utf8");

function functionBody(name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, "m");
  const match = signature.exec(source);
  assert.ok(match, `missing ${name}`);
  const start = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start + 1, index);
  }
  assert.fail(`unterminated ${name}`);
}

function ordered(body, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = body.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${label}: '${fragment}' is missing or out of order`);
    cursor = next;
  }
}

test("viewport discovers the capability only through its authenticated readonly client", () => {
  const connect = functionBody("tryConnect");
  ordered(connect, [
    'client.initialize("viewport_follower"',
    '"system.readonly", authToken',
    "state.client = client",
    "await discoverDerivedRuntime(client)",
  ], "readonly discovery");
  assert.match(functionBody("discoverDerivedRuntime"), /client\.callTool\(DERIVED_DISCOVERY_SKILL, \{\}\)/);
  assert.match(source, /let derivedRuntimeDiscovery;/);
  assert.doesNotMatch(source, /(?:textContent|dataset|localStorage|sessionStorage|console\.[a-z]+)\s*\([^)]*derivedRuntimeDiscovery/);
  assert.doesNotMatch(source, /JSON\.stringify\s*\(\s*derivedRuntimeDiscovery/);
  const contentAccess = functionBody("derivedMainRealmContentAccess");
  assert.match(contentAccess, /baseUrl: discovery\.baseUrl/);
  assert.match(contentAccess, /token: discovery\.token/);
  assert.match(contentAccess, /projectId: discovery\.projectId/);
  assert.match(contentAccess, /branchId: discovery\.branchId/);
});

test("Edit activation is runtime-specific, epoch guarded, retained, and reboot-safe", () => {
  const activate = functionBody("activateEditDerivedRevision");
  ordered(activate, [
    "const runtime = state.running",
    "const epoch = state.editRuntimeEpoch",
    "runtime.activateDerivedRevision(snapshot, { signal, contentAccess: derivedMainRealmContentAccess() })",
    "assertRuntimeDerivedRevision(runtime, snapshot)",
    "epoch !== state.editRuntimeEpoch",
    "state.running !== runtime",
    "state.latestEditDerivedRevision = snapshot",
  ], "Edit derived activation");
  const reboot = functionBody("reboot");
  ordered(reboot, [
    "const savedEditState = restore ?? captureEditState()",
    "state.rebooting = true",
    "state.editRuntimeEpoch++",
    "await closeEditDerivedClient()",
    "await stopRuntime(state.running)",
    "initialDerivedRevision",
    "restoreEditState(savedEditState)",
    "state.rebooting = false",
  ], "Edit reboot barrier");
  assert.match(functionBody("ensureEditDerivedClient"), /mode: "watch"/);
  assert.match(functionBody("ensureEditDerivedClient"), /residency: state\.running\.derivedTerrainResidency\(\)/);
  ordered(functionBody("ensureEditDerivedClient"), [
    "client.start(discovery",
    "subscribeDerivedResidency(",
    "state.derivedEditClient === client",
    "state.running === runtime",
  ], "Edit residency subscription");
  assert.match(functionBody("closeEditDerivedClient"), /DERIVED_CLOSE_BARRIER_TIMEOUT_MS/);
  ordered(functionBody("closeEditDerivedClient"), [
    "releaseEditDerivedResidency()",
    "state.derivedEditClient = undefined",
    "client?.close()",
  ], "Edit residency teardown");
  const invalidation = functionBody("invalidateEditDerivedRevision");
  assert.match(invalidation, /state\.latestEditDerivedRevision = undefined/);
  assert.match(invalidation, /state\.editRuntimeEpoch\+\+/);
  const batch = functionBody("applyWorldlogBatchInner");
  assert.ok(batch.match(/invalidateEditDerivedRevision\(\)/g)?.length >= 2);
  assert.match(batch, /const invalidatedDerived = invalidateEditDerivedRevision\(\)/);
  assert.match(batch, /!invalidatedDerived && state\.running/,
    "new authoring commands can still hot-apply over an invalidated derived presentation");
});

test("History removes current derived presentation before replaying a past prefix", () => {
  const history = functionBody("transitionHistoryPresentation");
  ordered(history, [
    "await waitForViewportIdle()",
    "await closeEditDerivedClient()",
    "state.scrubLimit = next",
    "await reboot()",
  ], "History presentation");
  assert.match(functionBody("reboot"), /const initialDerivedRevision = past \? undefined/);
});

test("Play uses a separate exact pin and cannot declare Playing before activation", () => {
  const pinned = functionBody("startPinnedDerivedClient");
  assert.match(pinned, /mode: "pinned"/);
  assert.match(pinned, /const activeManifestHash = runtime\.derivedRevision\(\)\?\.manifestHash/);
  assert.match(pinned, /manifestHash: activeManifestHash/);
  assert.match(pinned, /residency: runtime\.derivedTerrainResidency\(\)/);
  assert.match(pinned, /runtime\.activateDerivedRevision\(snapshot, \{ signal, contentAccess: derivedMainRealmContentAccess\(\) \}\)/);
  ordered(pinned, [
    "client.start(discovery",
    "subscribeDerivedResidency(",
    "state.derivedPlayClient === client",
    "state.playRuntime === runtime",
  ], "Play residency subscription");
  ordered(functionBody("closePlayDerivedClient"), [
    "releasePlayDerivedResidency()",
    "state.derivedPlayClient = undefined",
    "client.close()",
  ], "Play residency teardown");

  const play = functionBody("startPlay");
  ordered(play, [
    "await closeEditDerivedClient()",
    "sameDerivedSource(state.latestEditDerivedRevision, snapshot.source)",
    "state.playRuntime = runtime",
    "await startPinnedDerivedClient(runtime, snapshot.source, token)",
    "playLifecycle.started(token)",
  ], "pinned Play startup");
  assert.match(functionBody("stopPlay"), /await closePlayDerivedClient\(\)/);
  assert.match(functionBody("restoreEditWorld"), /await closePlayDerivedClient\(\)/);
});

test("camera residency forwarding coalesces updates and contains stale callbacks and failures", () => {
  const subscription = functionBody("subscribeDerivedResidency");
  assert.match(subscription, /pending = residency/);
  assert.match(subscription, /if \(flushing\) return/);
  assert.match(subscription, /await client\.setResidency\(residency\)/);
  assert.match(subscription, /closed \|\| !isCurrent\(\)/);
  assert.match(subscription, /if \(!closed && isCurrent\(\)\) setStatus\("derived", failureCode\)/);
  ordered(subscription, [
    "closed = true",
    "pending = undefined",
    "unsubscribe()",
  ], "residency unsubscribe");
  assert.match(functionBody("reboot"), /await closeEditDerivedClient\(\)/);
});

test("disconnect and unload forget the capability and bound both client shutdowns", () => {
  assert.match(functionBody("handleViewportDisconnect"), /closeDerivedClients\(\{ forgetDiscovery: true \}\)/);
  assert.match(functionBody("resetViewportConnection"), /closeDerivedClients\(\{ forgetDiscovery: true \}\)/);
  assert.match(functionBody("resetViewportConnection"), /state\.commands = \[\]/);
  assert.match(functionBody("resetViewportConnection"), /state\.cursor = 0/);
  assert.match(functionBody("resetViewportConnection"), /state\.latestEditDerivedRevision = undefined/);
  assert.match(functionBody("tryConnect"), /state\.client \|\| state\.connectionReset/);
  assert.match(source, /getElementById\("connect"\).*addEventListener\("click", resetViewportConnection\)/);
  assert.match(source, /getElementById\("disconnect"\).*addEventListener\("click", resetViewportConnection\)/);
  assert.match(functionBody("closeDerivedClients"), /Promise\.allSettled\(\[closeEditDerivedClient\(\), closePlayDerivedClient\(\)\]\)/);
  assert.match(source, /window\.addEventListener\("beforeunload"[\s\S]*closeDerivedClients\(\{ forgetDiscovery: true \}\)/);
  assert.match(source, /const DERIVED_PLAY_START_TIMEOUT_MS = 30_000/);
});
