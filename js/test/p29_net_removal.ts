// P29 -- authoritative `removed` delta path CONVERGENCE (headless, REAL sockets,
// falsifiable). Locks in the wave-1 fix: before it, an entity that left a client's
// relevant set (world despawn, an AoI-exit by movement, or a client-driven AoI
// shrink) LINGERED in the client's view forever, because the per-tick delta only
// carries the entities that CHANGED this tick -- an exited/despawned entity has NO
// entry in that client's `changes`, so the ONLY signal that drives its local view to
// drop the entity is the delta's `removed` list (and the aoi/declare removed push).
//
// One authoritative world, three real client connections:
//   - builder = a builder.readWrite driver (moves / destroys entities),
//   - viewer  = a player with a small AoI (the client under test),
//   - omni    = a player with FULL interest (the falsifiability control).
//
// Asserts three distinct removal triggers all converge the viewer's view:
//   A. AoI-EXIT BY MOVEMENT: an in-AoI entity is MOVED far outside the viewer's AoI.
//      It leaves viewer.state AND its id rides a `removed` delta; omni (full interest)
//      still sees it at the new position -> the removal is a PER-CLIENT AoI filter,
//      not a world despawn (falsifiable: a global despawn would drop it from omni too).
//   B. WORLD DESPAWN: an entity is destroyed. It leaves BOTH viewer.state and
//      omni.state (a real world removal), each via a `removed` delta.
//   C. AoI SHRINK: the viewer shrinks its AoI via aoi/declare. Entities now outside
//      the new AoI ride an immediate `removed` push and leave viewer.state, while
//      omni (which never changed interest) keeps them.
//
// FALSIFIABILITY: each entity is asserted PRESENT before its trigger, so the later
// absence is genuine CONVERGENCE (not an entity that was never there). Without the
// `removed` path the viewer's per-tick `changes` for an exited/despawned entity is
// empty, so viewer.state would still hold the stale record -- every "=== undefined"
// below would then fail. Omni's retained view (A, C) proves the drop is the AoI
// filter, not a missing/global event.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient } from "../src/net/client.ts";
import type { AreaOfInterest, NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p29_net_removal: " + message);
}

// Body-less marker: only intents move it, and syncAllBodies (which drives bodied
// entities from native transforms each tick) never clobbers it.
const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

// ===========================================================================
// PHASE 0 -- stand up the server + three real client connections.
// ===========================================================================
const AOI: AreaOfInterest = { center: [0, 0, 0], radius: 50 };
const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;

let movingId = "";  // in-AoI at (20,0,0); MOVED out (case A)
let doomedId = "";  // in-AoI at (15,0,0); DESTROYED (case B)
let nearId = "";    // in-AoI at (10,0,0); dropped by AoI SHRINK (case C)
const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p29_removal_server",
  seed: 0x2907,
  tickMs: 8,
  bootstrap: ({ world }) => {
    movingId = spawnMarker(world, 20, 0, 0);
    doomedId = spawnMarker(world, 15, 0, 0);
    nearId = spawnMarker(world, 10, 0, 0);
    // A couple of far fillers so the world is not trivially the AoI set.
    spawnMarker(world, 300, 0, 0);
    spawnMarker(world, 400, 0, 0);
  },
});
server.start();

const builder = await NetClient.connect(net, url);
const viewer = await NetClient.connect(net, url);
const omni = await NetClient.connect(net, url);
await builder.initialize("builder", "ses_builder", "builder.readWrite");
await viewer.initialize("viewer", "ses_viewer", "player.limited");
await omni.initialize("omni", "ses_omni", "player.limited");
await viewer.subscribe(AOI);
await omni.subscribe(); // full interest

// The three targets all start INSIDE the viewer's AoI join snapshot (so every
// later absence is a genuine convergence, not an entity that was never synced).
assert(viewer.state.has(movingId), "setup: viewer must see the moving entity in its join snapshot");
assert(viewer.state.has(doomedId), "setup: viewer must see the doomed entity in its join snapshot");
assert(viewer.state.has(nearId), "setup: viewer must see the near entity in its join snapshot");
assert(omni.state.has(movingId) && omni.state.has(doomedId), "setup: omni (full interest) must see all entities");

// ===========================================================================
// CASE A -- AoI-EXIT BY MOVEMENT: move an in-AoI entity far outside the viewer's
// AoI. It leaves viewer.state via a `removed` delta; omni keeps it (per-client filter).
// ===========================================================================
const aMove = await builder.call("ecs.updateComponent", { entity: movingId, component: "position", value: [500, 0, 0] });
assert(aMove.error === undefined, `builder move intent rejected: ${JSON.stringify(aMove.error)}`);
await ops.op_sleep_ms(120); // ~15 ticks: let the delta broadcast land

assert(viewer.state.get(movingId) === undefined,
  "CASE A: the AoI-exited entity STILL lingers in viewer.state -- the `removed` delta did not converge the view");
const aRemovedInStream = viewer.deltas.some((d) => (d.removed ?? []).includes(movingId));
assert(aRemovedInStream, "CASE A: the exited entity's id never rode a `removed` delta to the viewer");
const omniMoving = omni.state.get(movingId);
assert(omniMoving !== undefined && omniMoving.pos[0] === 500,
  "CASE A (falsifiable): omni (full interest) must still see the entity at its new position -- the drop is the AoI filter, not a world despawn");

// ===========================================================================
// CASE B -- WORLD DESPAWN: destroy an entity. It leaves BOTH views (real removal).
// ===========================================================================
const bDestroy = await builder.call("scene.destroyEntity", { entity: doomedId });
assert(bDestroy.error === undefined, `builder destroy intent rejected: ${JSON.stringify(bDestroy.error)}`);
await ops.op_sleep_ms(120);

assert(viewer.state.get(doomedId) === undefined,
  "CASE B: the despawned entity STILL lingers in viewer.state -- removal did not converge");
assert(omni.state.get(doomedId) === undefined,
  "CASE B: the despawned entity STILL lingers in omni.state -- a world despawn must drop from full interest too");
const bRemovedViewer = viewer.deltas.some((d) => (d.removed ?? []).includes(doomedId));
const bRemovedOmni = omni.deltas.some((d) => (d.removed ?? []).includes(doomedId));
assert(bRemovedViewer && bRemovedOmni, "CASE B: the despawn did not ride a `removed` delta to both subscribers");

// ===========================================================================
// CASE C -- AoI SHRINK via aoi/declare: entities now outside the new AoI ride an
// immediate `removed` push and leave viewer.state; omni (unchanged) keeps them.
// ===========================================================================
assert(viewer.state.get(nearId) !== undefined, "setup C: the near entity must still be in the viewer's view before the shrink");
const deltasBeforeShrink = viewer.deltas.length;
const cShrink = await viewer.declareAoi({ center: [0, 0, 0], radius: 5 }); // nearId at x=10 now outside
assert(cShrink.error === undefined, `aoi/declare rejected: ${JSON.stringify(cShrink.error)}`);
await ops.op_sleep_ms(60);

assert(viewer.state.get(nearId) === undefined,
  "CASE C: the entity dropped by the AoI shrink STILL lingers in viewer.state -- the aoi/declare `removed` push did not converge");
const cRemovedInStream = viewer.deltas.slice(deltasBeforeShrink).some((d) => (d.removed ?? []).includes(nearId));
assert(cRemovedInStream, "CASE C: the shrink did not push a `removed` delta carrying the dropped entity");
assert(omni.state.get(nearId) !== undefined,
  "CASE C (falsifiable): omni never shrank its interest, so it must still see the near entity -- the drop is the viewer's AoI change alone");

// ---- teardown -------------------------------------------------------------
await builder.close();
await viewer.close();
await omni.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log(
  "p29_net_removal OK: the authoritative `removed` delta path converges a client view for all three exit triggers -- " +
    "AoI-exit by movement (viewer drops it, omni keeps it at the new pos), world despawn (both drop it), " +
    "AoI shrink via aoi/declare (viewer drops it, omni keeps it); each id rode a real `removed` delta and each entity was present beforehand (genuine convergence, not never-synced).",
);
