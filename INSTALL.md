# Installing limina as an MCP server

limina ships a spec-compliant **stdio MCP server** so AI agent harnesses (Claude,
Codex, Cursor, local-inference tools, …) can call its world-building skills. The
installer builds/locates the binary, generates a launch wrapper, and registers
limina into the harnesses you pick.

## Quick start

```sh
# macOS / Linux
./install.sh

# Windows (PowerShell)
.\install.ps1
```

You'll get a menu of detected harnesses; choose by number, `all`, or `detected`.
The installer **asks before writing**, **backs up** every config it edits
(`<file>.bak`), and is **idempotent** (re-running replaces the limina entry, never
duplicates it).

Flags: `--dry-run` (show the plan, write nothing), `--yes` / `-Yes` (skip the
confirm prompt). On Windows: `-DryRun`, `-Yes`.

## What it does

1. **Binary** — uses `target/release/limina` (offers to `cargo build --release` if missing).
2. **Wrapper** — writes `bin/limina-mcp` (`.cmd` on Windows). limina's runtime loads
   its JS entry relative to the working directory, so the wrapper `cd`s into the repo
   before launching. This is why every harness points at the wrapper, not the binary —
   it makes the server work no matter where the client starts it.
3. **Harness config** — registers a server named **`limina`** that runs the wrapper.
   Uses each tool's CLI where one exists (`claude mcp add`, `codex mcp add`), otherwise
   merges the tool's config file in its own format.

## Supported harnesses

| Harness | Config | Notes |
|---|---|---|
| Claude Code | `claude mcp add` (user scope) | verified: connects |
| Claude Desktop | `mcpServers` JSON | quit & relaunch to load |
| OpenAI Codex CLI | `codex mcp add` / `config.toml` | verified: added |
| Cursor | `~/.cursor/mcp.json` | |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Refresh MCP panel |
| Cline (VS Code) | `cline_mcp_settings.json` | editor-variant path |
| LM Studio | `~/.lmstudio/mcp.json` | enable mcp.json in settings |
| Continue.dev | `~/.continue/config.yaml` | YAML; needs `pyyaml` (else snippet) |
| Goose | `~/.config/goose/config.yaml` | YAML; `cmd`/`extensions` schema |
| Zed | `settings.json` → `context_servers` | |

## Permissions

A standard MCP client doesn't supply limina's attribution, so connections are granted
the **`builder.readWrite`** profile (full authoring: scene/ecs/physics/agent/ui/audio).
Making this configurable per connection needs a small engine change (an env/argv channel
to the JS runtime) and is a tracked follow-up; today the default is fixed in
`js/src/mcp/mcp.ts`.

## Verify

```sh
# from anywhere — the wrapper handles the working directory
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | ./bin/limina-mcp
# → initialize returns serverInfo; tools/list returns tools with `inputSchema`.
```

In Claude Code: `claude mcp get limina` should report `Status: ✔ Connected`.

## Notes & limits

- The macOS/Linux installer is verified end-to-end (Claude Code connected, Codex added,
  all ten config writers produce correct output, idempotent, backed up). **`install.ps1`
  mirrors that logic but has not yet been run on Windows** — treat the first run as a
  smoke test (configs are still backed up).
- Continue and Goose are YAML; the shell installer uses `pyyaml` when present and prints
  a paste-in snippet otherwise. The PowerShell installer always prints the snippet for
  these two.
- The generated wrapper has an absolute path baked in and is git-ignored.
