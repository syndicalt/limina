// P4 / M5 -- interest management / area-of-interest (headless, REAL sockets,
// falsifiable).
//
// One authoritative world with K entities and TWO real client connections:
//   - client C declares a small AoI (a sphere at the origin),
//   - client D declares NO AoI (full interest = the whole world).
// A builder churns entities, INCLUDING one far OUTSIDE C's AoI and one INSIDE.
//
// Asserts (M5 acceptance):
//   1. The far entity's churn does NOT appear in C's actual delta stream (proven
//      by inspecting the real stream contents -- its id never appears), while an
//      in-AoI change DOES appear in C's stream.
//   2. The far entity IS a real, broadcast change -- D (full interest) receives
//      it -- so C's absence is the AoI FILTER, not a missing event (falsifiable).
//   3. C's stream is O(relevant), not O(K): even when ALL K entities churn, the
//      distinct entities C ever syncs equal its AoI set (<< K), whereas D's equal
//      K. Bandwidth scales with AoI, not world size.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient } from "../src/net/client.ts";
import type { AreaOfInterest, NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p4_interest_mgmt: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

// ---- Tunables -------------------------------------------------------------
const K = 300; // world entity count
const AOI: AreaOfInterest = { center: [0, 0, 0], radius: 50 };
// Marker i sits at (i, 0, 0): distance i from the origin. In AoI iff i <= 50.
const NEAR_I = 10; // inside the AoI
const FAR_I = 200; // far outside the AoI
const aoiCount = K === 0 ? 0 : Math.min(K, AOI.radius + 1); // i = 0..radius inclusive

// ===========================================================================
// PHASE 0 -- stand up the server with K entities + 2 real client connections.
// ===========================================================================
const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;

const markers: string[] = [];
const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p4_aoi_server",
  seed: 0x5eed,
  tickMs: 8,
  bootstrap: ({ world }) => {
    for (let i = 0; i < K; i++) markers.push(spawnMarker(world, i, 0, 0));
  },
});
server.start();

const near = markers[NEAR_I];
const far = markers[FAR_I];

const builder = await NetClient.connect(net, url); // churns the world
const viewer = await NetClient.connect(net, url); // client C: small AoI
const omniscient = await NetClient.connect(net, url); // client D: full interest
await builder.initialize("builder", "ses_builder", "builder.readWrite");
await viewer.initialize("viewer_C", "ses_c", "player.limited");
await omniscient.initialize("viewer_D", "ses_d", "player.limited");
await viewer.subscribe(AOI);
await omniscient.subscribe(); // no AoI -> full interest

// Join snapshot is itself AoI-filtered (the snapshot is part of the stream).
assert(viewer.snapshots.length === 1 && omniscient.snapshots.length === 1, "each subscriber should get exactly one join snapshot");
assert(viewer.snapshots[0].entities.length === aoiCount,
  `C's join snapshot carried ${viewer.snapshots[0].entities.length} entities, expected its AoI set (${aoiCount})`);
assert(omniscient.snapshots[0].entities.length === K,
  `D's join snapshot carried ${omniscient.snapshots[0].entities.length} entities, expected the whole world (${K})`);
assert(!viewer.seenEntityIds.has(far), "C's join snapshot leaked a far entity");
assert(viewer.seenEntityIds.has(near), "C's join snapshot missed an in-AoI entity");

// ===========================================================================
// PHASE 1 -- churn EVERY entity once. C must still sync only its AoI set.
// ===========================================================================
await Promise.all(markers.map((id) => builder.call("ecs.updateComponent", { entity: id, component: "scale", value: [2, 2, 2] })));
await ops.op_sleep_ms(80); // let the broadcast deltas land on C and D

// Inspect the ACTUAL stream contents (not a counter): the far entity's id must
// never appear in any delta C received, but it must appear in D's stream.
const farInViewerStream = viewer.deltas.some((d) => d.changes.some((e) => e.id === far));
const farInOmniscientStream = omniscient.deltas.some((d) => d.changes.some((e) => e.id === far));
assert(!farInViewerStream, "M5 BROKEN: the far entity appeared in C's delta stream despite being outside its AoI");
assert(farInOmniscientStream, "the far entity never reached D (full interest) -- the churn was not actually broadcast");
assert(!viewer.seenEntityIds.has(far), "C ever saw the far entity id");
assert(viewer.seenEntityIds.has(near), "C did not see the in-AoI entity churn");

// O(relevant), not O(K): distinct entities C syncs == its AoI set; D == K.
assert(viewer.seenEntityIds.size === aoiCount,
  `C synced ${viewer.seenEntityIds.size} distinct entities, expected its AoI set (${aoiCount})`);
assert(omniscient.seenEntityIds.size === K,
  `D synced ${omniscient.seenEntityIds.size} distinct entities, expected the whole world (${K})`);
assert(viewer.seenEntityIds.size * 2 < K,
  `C's synced set (${viewer.seenEntityIds.size}) is not strictly smaller than the world (${K}) -- AoI is not reducing bandwidth`);

// Total entity records carried also scales with AoI, not world size.
const viewerRecords = viewer.deltas.reduce((n, d) => n + d.changes.length, 0);
const omniscientRecords = omniscient.deltas.reduce((n, d) => n + d.changes.length, 0);
assert(viewerRecords < omniscientRecords,
  `C's stream volume (${viewerRecords}) should be far below D's (${omniscientRecords})`);

// ===========================================================================
// PHASE 2 -- a targeted live churn of the far + near entities (delta stream,
// not just the join snapshot) confirms the per-tick filter, falsifiably.
// ===========================================================================
const deltasBefore = viewer.deltas.length;
await builder.call("ecs.updateComponent", { entity: far, component: "scale", value: [9, 9, 9] });
await builder.call("ecs.updateComponent", { entity: near, component: "scale", value: [9, 9, 9] });
await ops.op_sleep_ms(80);

// The near change reached C with the new value; the far change never did, even
// though D (full interest) received it.
const cNear = viewer.state.get(near);
assert(cNear !== undefined && cNear.scale[0] === 9, "C did not receive the in-AoI live change");
assert(viewer.state.get(far) === undefined, "C received the far entity's live change (AoI filter failed)");
const dFar = omniscient.state.get(far);
assert(dFar !== undefined && dFar.scale[0] === 9, "D did not receive the far entity's live change");
const farInNewViewerDeltas = viewer.deltas.slice(deltasBefore).some((d) => d.changes.some((e) => e.id === far));
assert(!farInNewViewerDeltas, "the far entity entered C's live delta stream");

// ---- teardown -------------------------------------------------------------
await builder.close();
await viewer.close();
await omniscient.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log(
  `p4_interest_mgmt OK: ${K} entities, 1 authoritative world, 2 real client views; ` +
    `C (AoI r=${AOI.radius}) synced ${viewer.seenEntityIds.size} distinct entities / ${viewerRecords} records, ` +
    `D (full interest) synced ${omniscient.seenEntityIds.size} / ${omniscientRecords}; ` +
    `far entity (id=${far}, x=${FAR_I}) ABSENT from C's real delta stream but PRESENT in D's -> AoI filter is real; ` +
    `C stream is O(relevant=${aoiCount}) not O(K=${K})`,
);
