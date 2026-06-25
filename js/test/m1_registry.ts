// M1/M2/M6 — registry hook pipeline + Zod validation, EventLoom-shaped events +
// integrity chain, and permission denial. Headless (no GPU).

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

// Minimal world stub — the test skill never touches scene/camera.
const sceneStub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null };
const cameraStub = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: {}, entities: new EntityTable(), scene: sceneStub, camera: cameraStub, ops };

const tracer = new LiminaTracer("ses_test");
const registry = new SkillRegistry(tracer);

const order: string[] = [];
registry.register({
  name: "test.echo",
  version: "1.0.0",
  description: "doubles n",
  category: "system",
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number() }),
  permissions: ["test.run"],
  handler: (input, ctx) => {
    order.push("handler");
    ctx.emit("test.custom", { n: input.n });
    return { doubled: input.n * 2 };
  },
  hooks: {
    before: () => { order.push("before"); },
    after: () => { order.push("after"); },
  },
});

// describe + list (input_schema is the Zod-derived JSON Schema).
if (registry.describe("test.echo")?.version !== "1.0.0") throw new Error("describe failed");
const tool = registry.list().find((t) => t.name === "test.echo");
if (!tool) throw new Error("list missing tool");
const schema = tool.input_schema;
if (typeof schema !== "object" || schema === null || !("properties" in schema)) {
  throw new Error("input_schema is not an object schema");
}

const base = {
  agentId: "agt_test",
  sessionId: "ses_test",
  permissions: new Set(["test.run"]) as ReadonlySet<string>,
  tick: 1,
  world,
};

// Happy path: hook order + result.
const res = await registry.invoke("test.echo", { n: 21 }, base);
if (!res.success) throw new Error("invoke failed: " + JSON.stringify(res.error));
const result = res.result;
if (typeof result !== "object" || result === null || !("doubled" in result) || result.doubled !== 42) {
  throw new Error("wrong result");
}
if (order.join(",") !== "before,handler,after") throw new Error("hook order: " + order.join(","));
if (!res.metadata || res.metadata.eventsEmitted.length < 2) throw new Error("events not tracked");

// M2: EventLoom envelope on the emitted skill.executed event.
const exec = tracer.trace("agt_test").find((e) => e.type === "skill.executed");
if (!exec) throw new Error("no skill.executed event");
for (const field of ["id", "type", "actorId", "threadId", "parentEventId", "causedBy", "timestamp", "payload"]) {
  if (!(field in exec)) throw new Error("envelope missing field: " + field);
}
if (!exec.id.startsWith("evt_agt_test_")) throw new Error("bad structured id: " + exec.id);
if (exec.parentEventId !== null) throw new Error("parentEventId should be null");

// M2: exported JSONL has a verifiable sha256 previousHash chain.
const jsonl = tracer.exportJsonl();
const lines = jsonl.trim().split("\n");
let prev: string | null = null;
for (const line of lines) {
  const ev: { integrity: { hash: string; previousHash: string | null } } = JSON.parse(line);
  if (ev.integrity.previousHash !== prev) throw new Error("integrity chain break");
  if (!ev.integrity.hash.startsWith("sha256:")) throw new Error("missing sha256 prefix");
  prev = ev.integrity.hash;
}

// Invalid input + unknown skill -> structured errors.
const bad = await registry.invoke("test.echo", { n: "nope" }, base);
if (bad.success || bad.error?.code !== "invalid_input") throw new Error("invalid_input not caught");
const unk = await registry.invoke("test.missing", {}, base);
if (unk.success || unk.error?.code !== "not_found") throw new Error("not_found not caught");

// M6: permission denial -> forbidden + observable event.
const limited = { ...base, permissions: new Set<string>() as ReadonlySet<string> };
const denied = await registry.invoke("test.echo", { n: 1 }, limited);
if (denied.success || denied.error?.code !== "forbidden") throw new Error("forbidden not caught");
if (!tracer.trace("agt_test").some((e) => e.type === "security.permission.denied")) {
  throw new Error("no permission.denied event");
}

ops.op_log("M1/M2/M6 OK: registry hooks+validation, EventLoom envelope+sha256 chain, permission denial");
