---
title: "Building with Agent Builders"
description: "Connect an external LLM agent over MCP and construct a scene, fully typed and traced."
---

An **Agent Builder** is an external agent — your LLM, your gateway, your own loop — that connects to Limina over [MCP](/pillars/mcp-interface) and constructs a scene by calling skills. It never touches the engine internals; it discovers the tool surface, then issues a sequence of `callTool` requests. Every call is schema-validated, permission-checked, and traced into the world log. This page walks a concrete build with the real skill names from the [Skills catalog](/skills).

## Quickstart: stdio

Build the engine, then start the stdio MCP server:

```bash
cargo build --release
./target/release/limina --mcp-stdio
```

It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and exits on stdin EOF. A minimal external client lives at `examples/mcp_stdio_client.mjs` — it spawns the binary and sends `initialize → tools/list → tools/call → shutdown`:

```js
import { spawn } from "node:child_process";

const child = spawn("target/release/limina", ["--mcp-stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { agentId: "agt_external", sessionId: "ses_external", profile: "builder.readWrite" } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "scene.queryEntities", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "shutdown", params: {} },
];
for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
child.stdin.end();
```

Run it:

```bash
node examples/mcp_stdio_client.mjs
```

The `initialize` step binds the session and its permissions from the profile (`permissions = resolveProfile("builder.readWrite")`). After that, every `tools/call` runs under those grants.

## A concrete build sequence

A builder follows the same shape every time: **discover, then call**. Here is a full scene built skill by skill. Each `tools/call` returns an `MCPResponse`; entity ids (`ent_…`) thread through later calls.

### 1. Discover the surface

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

The result is the tool list — each tool a `{ name, description, input_schema }` with a JSON Schema (draft-07) input. Your agent can now plan calls against real schemas instead of guessing. (`skills.describe { name }` returns a single tool's metadata if you want detail on demand.)

### 2. Light the scene — `three.setLighting`

```json
{ "name": "three.setLighting",
  "arguments": { "directionalIntensity": 4, "castShadow": true } }
```

One ambient + one directional light, optionally casting real shadow maps. Requires `scene.write`. → `{ ok: true }`

### 3. Create an entity — `scene.createEntity`

```json
{ "name": "scene.createEntity",
  "arguments": { "shape": "box", "color": 4886754, "position": [0, 0.5, 0], "dynamic": true } }
```

Creates a renderable box (optionally with a dynamic physics body) and returns its id. Requires `scene.write`. → `{ entity: "ent_0001" }`

### 4. Position it — `three.setTransform`

```json
{ "name": "three.setTransform",
  "arguments": { "entity": "ent_0001", "position": [2, 0.5, -1], "rotationEuler": [0, 0.78, 0] } }
```

Sets position, rotation (Euler radians), and/or scale. Requires `scene.write`. → `{ ok: true }`

### 5. Style it — `three.setMaterial`

```json
{ "name": "three.setMaterial",
  "arguments": { "entity": "ent_0001", "color": 16747546, "roughness": 0.4, "metalness": 0.1, "receiveShadow": true } }
```

Updates the PBR material and shadow participation (applies across all meshes of a glTF entity). Requires `scene.write`. → `{ ok: true }`

### 6. Load a model — `three.loadGLTF`

```json
{ "name": "three.loadGLTF",
  "arguments": { "assetId": "tree_oak", "position": [-3, 0, 2] } }
```

Loads a glTF/glb from a **sandboxed asset id** (not an arbitrary path) and adds it at a position. Requires `scene.write`. → `{ entity: "ent_0002", resource: { kind: "gltf", meshCount: 3, materialCount: 2, ... } }`

At any point the builder can query what exists with `scene.queryEntities` (filter by tag and/or radius) or take a full `inspector.snapshot`.

## A permission-denied call, also traced

The `builder.readWrite` profile grants scene/ecs/physics/ui/audio write but **not** `social.act` (that capability belongs to `social.actor`). So a builder attempting to speak as an agent is denied — cleanly, with zero effect:

```json
{ "name": "social.say", "arguments": { "text": "hello" } }
```

→ JSON-RPC error `-32001` with `error.data`:

```json
{
  "success": false,
  "error": { "code": "forbidden", "message": "missing permission: social.act" }
}
```

The denial is not silent: the engine emits a `security.permission.denied { skill, missing, agentId }` event into the trace (and, under the dynamic policy engine, a `policy.denied` decision). The world log records the *attempt* and the *refusal*, not just the successes — which is exactly what makes the surface auditable.

## Everything is traced

Each successful call emits `skill.executed { skill, version, input, tick }`; each denial emits `security.permission.denied`. The whole sequence forms a causal chain you can replay with `trace.tail` and `trace.explainEvent`, or seal and export with `trace.export` (a hash-chained JSONL file). The headless `builder.ts` demo does exactly this end to end:

```bash
./target/release/limina js/src/demos/builder.ts
```

An in-process agent discovers the tools, builds a scene (`createEntity` / `setTransform` / `setMaterial` / `setLighting` / `loadGLTF`), hits one permission-denied call, and the whole permission-checked, traced sequence is verified — the same path an external agent takes over stdio or [WebSocket](/pillars/mcp-interface). To see the agents themselves, visit [Agents](/agents).
