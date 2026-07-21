# limina editor bridge

`limina-bridge.mjs` is a thin MCP-over-stdio proxy for a running Limina `editor_host`.
The coding agent speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. The bridge
connects to the same localhost WebSocket server that the browser viewport uses,
authenticates with the editor token, and forwards `tools/list` and `tools/call`
without keeping local world state or adding local skill logic.

The bridge needs a running `editor_host` and the `LIMINA_EDITOR_TOKEN` stored in
the private capability file reported by the project editor launcher.

## Configuration

- `LIMINA_EDITOR_URL`: WebSocket URL, default `ws://localhost:8787/`
- `LIMINA_EDITOR_TOKEN`: required editor auth token from the launcher's private capability file
- `LIMINA_AGENT_ID`: default `limina-coordinator`
- `LIMINA_SESSION_ID`: default stable per-process id
- `LIMINA_PROFILE`: default `builder.readWrite`
- `LIMINA_CALL_TIMEOUT_MS`: default `10000`

Node 22+ provides the built-in global `WebSocket`, which the bridge uses by
default. If it is unavailable, the bridge falls back to the `ws` package.

## Agent registration

Example MCP server entry:

```json
{
  "mcpServers": {
    "limina-editor": {
      "command": "node",
      "args": ["tools/bridge/limina-bridge.mjs"],
      "env": {
        "LIMINA_EDITOR_TOKEN": "copy-editor-host-token-here"
      }
    }
  }
}
```

Each builder subagent should run its own bridge process with a distinct
`LIMINA_AGENT_ID`, so the editor recorder tracks distinct authoring chains.

## Verification

```sh
node --check tools/bridge/limina-bridge.mjs
node tools/bridge/limina-bridge.test.mjs
```
