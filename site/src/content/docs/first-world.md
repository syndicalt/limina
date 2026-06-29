---
title: "Your first world"
description: "Zero to a playable, agent-authorable world in a browser tab in under a minute with create-limina-app, then connect an agent over MCP."
---

This is the fast path: a world playing in a browser tab in **under a minute**, no native
toolchain. You scaffold a project with `npx`, run it, edit one file — `world.ts` — and
re-export. When you want to drive the world from an agent instead of by hand, the
[MCP quickstart](#connect-an-agent-over-mcp) at the bottom connects one in a few lines.

:::note[Two on-ramps]
This page is the **npx** on-ramp — browser playback, no Rust, no GPU setup. If you want
to build and run the native engine directly (windowed demos, headless tests, the full MCP
server), use [Getting started](/getting-started) instead. They meet in the middle: both
author worlds through the same [skills](/skills).
:::

## The 60-second start

```bash
# 1 — scaffold a project (a starter world.ts + the dev/export/serve scripts)
npx create-limina-app my-world

# 2 — install dependencies
cd my-world && npm install

# 3 — play it in a browser tab — no native toolchain required
npm run dev
```

After `npm run dev`, a world opens in a browser tab. That is the whole first run: a
real, agent-authored world playing in the browser via the same export-playback path the
[live examples](/examples) use — so it needs no Rust, no WebGPU build, nothing but Node.

Then make it yours:

```bash
# 4 — edit world.ts (your world, authored as a sequence of skill calls)

# 5 — build dist/ from your world.ts (uses the native limina binary)
npm run export

# 6 — serve the freshly built world in a tab
npm run serve
```

| Step | Command | What it does | What you see |
|------|---------|--------------|--------------|
| 1 | `npx create-limina-app my-world` | Scaffolds `my-world/` — a starter `world.ts`, the skill/MCP wiring, and the `dev` / `export` / `serve` scripts. | A new project directory. |
| 2 | `npm install` | Installs the JS dependencies. | A populated `node_modules/`. |
| 3 | `npm run dev` | Serves the starter world over the browser playback path. | A world playing in a browser tab, in well under 60 seconds. |
| 4 | edit `world.ts` | You (or an agent) change the world — add entities, terrain, lights, props. | — |
| 5 | `npm run export` | Runs your `world.ts` through the native `limina` binary and writes the portable bundle to `dist/`. | A built `dist/`. |
| 6 | `npm run serve` | Serves `dist/` locally. | Your edited world playing in a tab. |

## Editing world.ts

`world.ts` is your world expressed as a sequence of **skill calls** — the same typed,
permission-checked surface agents use. Authoring a box, a patch of terrain, and a light
looks like this:

```ts
// world.ts — author your world through skills.
export default async function world({ scene, world, three }) {
  // A patch of terrain with auto surfaces, then trees/rocks for the biome.
  await world.generateRegion({ seed: 1234, type: "mountains", bounds: { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } });
  await world.populateBiome({ region: "r0" });

  // A dynamic box and a directional light.
  const box = await scene.createEntity({ shape: "box", position: [0, 4, 0], color: 0xff6a00, dynamic: true });
  await three.setLighting({ directional: { intensity: 1.2, position: [5, 10, 5], castShadow: true } });
}
```

Every call above is a real skill. The full set — names, the permissions each needs, and
the exact JSON-Schema inputs — is the [Skills reference](/skills); the same catalog is
available as machine-readable JSON at [`/agents/skills.json`](/agents/skills.json). You
don't have to memorize it: an agent connected over MCP can discover and call these for
you (next section).

## Connect an agent over MCP

Everything in `world.ts` is also reachable from outside the process. The native `limina`
binary runs an [MCP](/pillars/mcp-interface) server, so any MCP client — your agent — can
open a session, list the tools, and call them. This path needs the native binary (see
[Getting started](/getting-started) to build it).

Start the server. It speaks newline-delimited JSON-RPC 2.0 over stdio, or over a
localhost WebSocket:

```bash
# stdio — ideal for a local subprocess client
./target/release/limina --mcp-stdio

# or a localhost WebSocket (default port 8787; --port to change it)
./target/release/limina --mcp-ws --port 8787
```

A session is `initialize` → `tools/list` → `tools/call`. Open it under a permission
profile, discover the tools, then create an entity:

```jsonc
// 1 — open a session under a permission profile
→ {"jsonrpc":"2.0","id":1,"method":"initialize",
   "params":{"agentId":"builder-1","sessionId":"s1","profile":"builder.readWrite"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-06-23",
   "session":{"agentId":"builder-1","sessionId":"s1","profile":"builder.readWrite"}}}

// 2 — discover the tools (each input_schema is JSON Schema draft-07)
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"scene.createEntity", ...}]}}

// 3 — call a skill: spawn a box
→ {"jsonrpc":"2.0","id":3,"method":"tools/call",
   "params":{"name":"scene.createEntity",
     "arguments":{"shape":"box","position":[0,1,0],"color":16746496,"dynamic":true}}}
← {"jsonrpc":"2.0","id":3,"result":{"success":true,"result":{"entity":"ent_12"},
   "metadata":{"executionTimeMs":0.4,"eventsEmitted":["skill.executed"]}}}

// 4 — confirm it's in the world
→ {"jsonrpc":"2.0","id":4,"method":"tools/call",
   "params":{"name":"scene.queryEntities","arguments":{}}}
← {"jsonrpc":"2.0","id":4,"result":{"success":true,"result":{"entities":[{"entity":"ent_12", ...}]}}}
```

The entity now exists in the world. The MCP server is headless, so you confirm it with
`scene.queryEntities` (above) or watch it over the WebSocket server's read-only
state-sync channel — the same authoritative state observers read.

A runnable version of exactly this handshake ships in the repo:

```bash
node examples/mcp_stdio_client.mjs
```

It spawns the binary in `--mcp-stdio` mode and walks `initialize → tools/list →
tools/call → shutdown`, printing each response. Errors come back as JSON-RPC errors with
the full response attached as `error.data`; the codes are `not_found`, `invalid_input`,
`forbidden`, `handler_error`, and `capacity_exceeded`.

## Next steps

- **Author with an agent.** Point any MCP client at the server above and let it build —
  see [Agent Builders](/building-agents/builders). To spawn an agent that lives *inside*
  the world, see [Agent Players](/building-agents/players).
- **Browse the surface.** The [Skills reference](/skills) is every skill an agent (or
  your `world.ts`) can call; [`/agents/skills.json`](/agents/skills.json) is the same
  catalog as machine-readable JSON.
- **See it running.** The [live examples](/examples) play in your browser, and the
  [Demos](/demos) page is the full native catalog — physics, agents, audio, and UI.
