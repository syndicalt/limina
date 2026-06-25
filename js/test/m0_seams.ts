// M0 — verify the exposed seams: entity-table no-reuse, physics id tombstone +
// impulse + raycast, sandboxed op_read_asset, async op_http_post.

import { EntityTable, ops } from "../src/engine.ts";

// 1. EntityTable: ent_ ids are monotonic and never reused after destroy.
const table = new EntityTable();
const a = table.create({ eid: 0 });
table.create({ eid: 1 });
table.destroy(a);
const c = table.create({ eid: 0 }); // eid may recycle; ent_ id must not
if (table.resolve(a) !== undefined) throw new Error("destroyed ent_ still resolves");
if (table.resolve(c) === undefined) throw new Error("new ent_ missing");
if (a === c) throw new Error("ent_ id reused after destroy");

// 2. Physics: removed body id is tombstoned; new ids are not recycled.
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const id0 = ops.op_physics_add_box(0, 5, 0, 0.5);
ops.op_physics_add_box(2, 5, 0, 0.5);
ops.op_physics_remove_body(id0);
const id2 = ops.op_physics_add_box(-2, 5, 0, 0.5);
if (id2 === id0) throw new Error("physics body id recycled");

const pos = new Float32Array(3);
ops.op_physics_body_pos(id2, pos);
if (Math.abs(pos[1] - 5) > 0.01) throw new Error(`new body y expected ~5, got ${pos[1]}`);

const removed = new Float32Array([9, 9, 9]);
ops.op_physics_body_pos(id0, removed); // tombstoned -> op no-ops
if (removed[0] !== 9) throw new Error("removed body still has a position");

// 3. apply_impulse wakes a resting body; raycast hits the ground.
for (let i = 0; i < 120; i++) ops.op_physics_step();
const before = new Float32Array(3);
ops.op_physics_body_pos(id2, before);
ops.op_physics_apply_impulse(id2, 12, 0, 0); // shove +x
for (let i = 0; i < 30; i++) ops.op_physics_step();
const after = new Float32Array(3);
ops.op_physics_body_pos(id2, after);
if (after[0] <= before[0] + 0.05) throw new Error(`impulse did not move a sleeping body: ${before[0]} -> ${after[0]}`);

const rc = new Float32Array(6);
ops.op_physics_raycast(0, 10, 0, 0, -1, 0, 100, rc); // straight down at x=0 -> ground
if (rc[0] !== 1) throw new Error("raycast missed the ground");
if (Math.abs(rc[3] - 0) > 0.6) throw new Error(`raycast hit y expected ~0, got ${rc[3]}`);

// 4. op_read_asset: relative ok; traversal + absolute rejected.
const bytes = ops.op_read_asset("test.txt");
if (!(bytes instanceof Uint8Array) || bytes.length !== 6 || bytes[0] !== 108) {
  throw new Error("asset read returned wrong bytes");
}
let traversalBlocked = false;
try { ops.op_read_asset("../Cargo.toml"); } catch { traversalBlocked = true; }
if (!traversalBlocked) throw new Error("`..` traversal not blocked");
let absoluteBlocked = false;
try { ops.op_read_asset("/etc/passwd"); } catch { absoluteBlocked = true; }
if (!absoluteBlocked) throw new Error("absolute path not blocked");

// 5. op_http_post async round-trip (Ollama /api/show — metadata, no inference).
const resp = await ops.op_http_post(
  "http://localhost:11434/api/show",
  JSON.stringify({ name: "qwen2.5-coder:3b" }),
);
const parsed: unknown = JSON.parse(resp);
if (typeof parsed !== "object" || parsed === null) throw new Error("http_post bad response");

ops.op_log("M0 OK: entity-table no-reuse, physics tombstone+impulse+raycast, sandboxed asset, async http_post");
