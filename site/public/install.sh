#!/usr/bin/env bash
# limina MCP installer (macOS / Linux).
#
# Builds/locates the `limina` binary, generates a working-directory wrapper
# (the runtime loads js/src/mcp/stdio_runtime.ts relative to CWD), and registers
# limina as a spec-compliant stdio MCP server in the agent harnesses you select.
#
# Safe by default: prints a plan and asks before writing; every config it edits
# is backed up first; re-running replaces the limina entry idempotently.
#
#   ./install.sh            interactive
#   ./install.sh --dry-run  show what would change, write nothing
#   ./install.sh --yes      skip the confirm prompt (still backs up)
#   ./install.sh --help

set -euo pipefail

SRC="${BASH_SOURCE[0]:-$0}"
REPO="$(cd "$(dirname "$SRC")" 2>/dev/null && pwd || pwd)"
BIN="$REPO/target/release/limina"
WRAPPER_DIR="$REPO/bin"
WRAPPER="$WRAPPER_DIR/limina-mcp"
SERVER_NAME="limina"
REPO_URL="${LIMINA_REPO_URL:-https://github.com/syndicalt/limina.git}"
LIMINA_DIR="${LIMINA_DIR:-$HOME/.limina}"
BOOTSTRAP=0

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --help|-h)
      cat <<'USAGE'
limina MCP installer (macOS / Linux)

Registers limina as a spec-compliant stdio MCP server in the agent harnesses
you select. Run from a cloned repo, or remotely:

  curl -fsSL https://www.liminaengine.com/install.sh | bash

  --dry-run   show what would change, write nothing
  --yes       skip the confirm prompt (still backs up)
  --help

Env: LIMINA_DIR (clone target, default ~/.limina)
     LIMINA_HARNESSES (non-interactive selection: all | detected | comma,list)
USAGE
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) echo "Unsupported OS $(uname -s); use install.ps1 on Windows." >&2; exit 1 ;;
esac

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

require_py() {
  command -v python3 >/dev/null 2>&1 || { echo "python3 is required for config merging." >&2; exit 1; }
}

# Read a line even when the script is piped (curl|bash): prefer the controlling
# terminal, fall back to a default for fully non-interactive runs.
ask() { # ask <prompt> <default>
  local prompt="$1" default="${2:-}"
  if [ -t 0 ]; then printf '%s' "$prompt"; read -r REPLY || REPLY=""
  elif [ -e /dev/tty ]; then printf '%s' "$prompt"; read -r REPLY < /dev/tty || REPLY=""
  else REPLY="$default"; fi
  [ -n "$REPLY" ] || REPLY="$default"
}

# ----------------------------------------------------------------------------
# 0. Bootstrap — when run outside a limina checkout (e.g. curl | bash), clone
#    the repo and build from source, then continue against that checkout.
# ----------------------------------------------------------------------------
bootstrap_if_needed() {
  [ -f "$REPO/js/src/mcp/stdio_runtime.ts" ] && return     # already in a checkout
  BOOTSTRAP=1
  REPO="$LIMINA_DIR"; BIN="$REPO/target/release/limina"
  WRAPPER_DIR="$REPO/bin"; WRAPPER="$WRAPPER_DIR/limina-mcp"
  if [ "$DRY_RUN" = 1 ]; then warn "(dry-run) would clone $REPO_URL → $LIMINA_DIR and build"; return; fi
  command -v git >/dev/null 2>&1 || { echo "git is required to bootstrap limina." >&2; exit 1; }
  command -v cargo >/dev/null 2>&1 || { echo "Rust/cargo is required to build limina — see https://rustup.rs" >&2; exit 1; }
  if [ -f "$REPO/js/src/mcp/stdio_runtime.ts" ]; then
    bold "Updating limina checkout in $LIMINA_DIR"; git -C "$REPO" pull --ff-only || warn "pull failed; using existing checkout"
  else
    bold "Cloning limina into $LIMINA_DIR"; git clone --depth 1 "$REPO_URL" "$REPO"
  fi
}

# ----------------------------------------------------------------------------
# 1. Ensure the binary exists
# ----------------------------------------------------------------------------
ensure_binary() {
  if [ -x "$BIN" ]; then say "✓ limina binary: $BIN"; return; fi
  if [ "$DRY_RUN" = 1 ]; then warn "(dry-run) would build limina with 'cargo build --release'"; return; fi
  command -v cargo >/dev/null 2>&1 || { echo "Rust/cargo is required to build limina — see https://rustup.rs" >&2; exit 1; }
  if [ "$BOOTSTRAP" = 1 ]; then
    bold "Building limina from source (compiles a Rust project — a few minutes)…"
    ( cd "$REPO" && cargo build --release )
  else
    warn "limina binary not found at $BIN"
    ask "Build it now with 'cargo build --release'? [y/N] " "n"
    case "$REPLY" in y|Y) ( cd "$REPO" && cargo build --release ) ;; *) echo "Cannot continue without the binary." >&2; exit 1 ;; esac
  fi
}

# ----------------------------------------------------------------------------
# 2. Generate the working-directory wrapper
# ----------------------------------------------------------------------------
generate_wrapper() {
  if [ "$DRY_RUN" = 1 ]; then say "✓ (dry-run) would write wrapper: $WRAPPER"; return; fi
  mkdir -p "$WRAPPER_DIR"
  cat > "$WRAPPER" <<EOF
#!/bin/sh
# Auto-generated by install.sh. Launches limina's MCP server from the repo root
# so the runtime can resolve js/src/mcp/stdio_runtime.ts (a CWD-relative path).
cd "$REPO" || exit 1
exec "$BIN" --mcp-stdio "\$@"
EOF
  chmod +x "$WRAPPER"
  say "✓ wrapper: $WRAPPER"
}

# ----------------------------------------------------------------------------
# Config-merge helpers (python3; back up + idempotent)
# ----------------------------------------------------------------------------
# merge_json <file> <parent_key> <server_name> <command> [extra_json]
#   sets file[parent_key][server_name] = {command, args:[], <extra_json>}
merge_json() {
  local file="$1" parent="$2" name="$3" cmd="$4" extra="${5:-{\}}"
  if [ "$DRY_RUN" = 1 ]; then say "  would merge into $file  ($parent.$name)"; return; fi
  require_py
  python3 - "$file" "$parent" "$name" "$cmd" "$extra" <<'PY'
import json, os, sys, shutil
path, parent, name, cmd, extra = sys.argv[1:6]
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {}
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
    try:
        with open(path) as f: data = json.load(f)
    except Exception as e:
        print(f"  ! {path} is not valid JSON ({e}); wrote nothing, left .bak"); sys.exit(0)
if not isinstance(data, dict): data = {}
entry = {"command": cmd, "args": []}
entry.update(json.loads(extra))
data.setdefault(parent, {})[name] = entry
with open(path, "w") as f: json.dump(data, f, indent=2); f.write("\n")
print(f"  ✓ {path}")
PY
}

# merge_json_nested <file> <server_name> <command>  — Claude Code user scope (~/.claude.json top-level mcpServers)
merge_claude_json() { merge_json "$1" "mcpServers" "$SERVER_NAME" "$WRAPPER"; }

# CLI-based registration, preferred when the tool is installed.
register_via_cli() {
  local tool="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then say "  would run: $* "; return 0; fi
  "$@"
}

# ----------------------------------------------------------------------------
# 3. Harness registry — each entry: key|label|detect|writer
# ----------------------------------------------------------------------------
home="$HOME"
declare -a H_KEYS=()
declare -A H_LABEL H_DETECT H_PATH

reg() { H_KEYS+=("$1"); H_LABEL["$1"]="$2"; H_DETECT["$1"]="$3"; H_PATH["$1"]="$4"; }

if [ "$OS" = mac ]; then
  CLAUDE_DESKTOP="$home/Library/Application Support/Claude/claude_desktop_config.json"
  CLINE="$home/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
  ZED="$home/.config/zed/settings.json"
else
  CLAUDE_DESKTOP="$home/.config/Claude/claude_desktop_config.json"
  CLINE="$home/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
  ZED="$home/.config/zed/settings.json"
fi

reg claude-code    "Claude Code (CLI)"        "command -v claude"            ""
reg claude-desktop "Claude Desktop"           "[ -e '$CLAUDE_DESKTOP' ]"     "$CLAUDE_DESKTOP"
reg codex          "OpenAI Codex CLI"         "command -v codex"            "$home/.codex/config.toml"
reg cursor         "Cursor"                   "[ -d '$home/.cursor' ]"      "$home/.cursor/mcp.json"
reg windsurf       "Windsurf"                 "[ -d '$home/.codeium/windsurf' ]" "$home/.codeium/windsurf/mcp_config.json"
reg cline          "Cline (VS Code)"          "[ -e '$CLINE' ] || [ -d '$(dirname "$(dirname "$CLINE")")' ]" "$CLINE"
reg lmstudio       "LM Studio"                "[ -d '$home/.lmstudio' ] || [ -d '$home/.cache/lm-studio' ]" "$home/.lmstudio/mcp.json"
reg continue       "Continue.dev"             "[ -d '$home/.continue' ]"    "$home/.continue/config.yaml"
reg goose          "Goose"                    "[ -e '$home/.config/goose/config.yaml' ]" "$home/.config/goose/config.yaml"
reg zed            "Zed"                      "[ -e '$ZED' ]"               "$ZED"

detected() { eval "${H_DETECT[$1]}" >/dev/null 2>&1; }

# writer per harness — all point command at the wrapper (no cwd key needed anywhere)
write_harness() {
  local key="$1"
  case "$key" in
    claude-code)
      if command -v claude >/dev/null 2>&1; then
        register_via_cli claude claude mcp add --scope user --transport stdio "$SERVER_NAME" -- "$WRAPPER" \
          && say "  ✓ claude mcp add ($SERVER_NAME)"
      else merge_json "$home/.claude.json" "mcpServers" "$SERVER_NAME" "$WRAPPER"; fi ;;
    codex)
      if command -v codex >/dev/null 2>&1; then
        register_via_cli codex codex mcp add "$SERVER_NAME" -- "$WRAPPER" && say "  ✓ codex mcp add ($SERVER_NAME)"
      else write_toml "${H_PATH[$key]}"; fi ;;
    claude-desktop|cursor|windsurf|lmstudio) merge_json "${H_PATH[$key]}" "mcpServers" "$SERVER_NAME" "$WRAPPER" ;;
    cline) merge_json "${H_PATH[$key]}" "mcpServers" "$SERVER_NAME" "$WRAPPER" '{"disabled":false,"autoApprove":[]}' ;;
    zed)   merge_json "${H_PATH[$key]}" "context_servers" "$SERVER_NAME" "$WRAPPER" '{"enabled":true}' ;;
    continue) write_continue "${H_PATH[$key]}" ;;
    goose)    write_goose "${H_PATH[$key]}" ;;
  esac
}

# Codex TOML (fallback when the codex CLI is absent)
write_toml() {
  local file="$1"
  if [ "$DRY_RUN" = 1 ]; then say "  would add [mcp_servers.$SERVER_NAME] to $file"; return; fi
  require_py
  python3 - "$file" "$SERVER_NAME" "$WRAPPER" <<'PY'
import os, sys, shutil, re
path, name, cmd = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
block = f'\n[mcp_servers.{name}]\ncommand = "{cmd}"\nargs = []\n'
text = ""
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
    text = open(path).read()
    # drop a previous limina block (idempotent)
    text = re.sub(rf'\n\[mcp_servers\.{re.escape(name)}\][^\[]*', '\n', text)
open(path, "w").write(text.rstrip("\n") + "\n" + block)
print(f"  ✓ {path}")
PY
}

# Continue.dev YAML (array of mcpServers). Uses pyyaml if available; else snippet.
write_continue() {
  local file="$1"
  if [ "$DRY_RUN" = 1 ]; then say "  would add mcpServers entry to $file"; return; fi
  require_py
  python3 - "$file" "$SERVER_NAME" "$WRAPPER" <<'PY'
import os, sys, shutil
path, name, cmd = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    import yaml
except Exception:
    snip = f"  - name: {name}\n    command: {cmd}\n    args: []\n"
    print("  ! pyyaml not installed — add this under mcpServers: in", path)
    print(snip); sys.exit(0)
data = {}
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
    try: data = yaml.safe_load(open(path)) or {}
    except Exception as e: print(f"  ! {path} unparseable ({e}); left .bak"); sys.exit(0)
data.setdefault("name", "My Config"); data.setdefault("version", "1.0.0"); data.setdefault("schema", "v1")
servers = [s for s in (data.get("mcpServers") or []) if s.get("name") != name]
servers.append({"name": name, "command": cmd, "args": []})
data["mcpServers"] = servers
yaml.safe_dump(data, open(path, "w"), sort_keys=False)
print(f"  ✓ {path}")
PY
}

# Goose YAML (extensions map; keys cmd/envs, not command/env)
write_goose() {
  local file="$1"
  if [ "$DRY_RUN" = 1 ]; then say "  would add extensions.$SERVER_NAME to $file"; return; fi
  require_py
  python3 - "$file" "$SERVER_NAME" "$WRAPPER" <<'PY'
import os, sys, shutil
path, name, cmd = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    import yaml
except Exception:
    print("  ! pyyaml not installed — add this under extensions: in", path)
    print(f"  {name}:\n    type: stdio\n    name: {name}\n    cmd: {cmd}\n    args: []\n    enabled: true\n"); sys.exit(0)
data = {}
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
    try: data = yaml.safe_load(open(path)) or {}
    except Exception as e: print(f"  ! {path} unparseable ({e}); left .bak"); sys.exit(0)
data.setdefault("extensions", {})[name] = {
    "type": "stdio", "name": name, "cmd": cmd, "args": [], "enabled": True, "timeout": 300,
}
yaml.safe_dump(data, open(path, "w"), sort_keys=False)
print(f"  ✓ {path}")
PY
}

# ----------------------------------------------------------------------------
# 4. Interactive selection
# ----------------------------------------------------------------------------
bold "limina MCP installer  ($OS)"
bootstrap_if_needed
ensure_binary
generate_wrapper
echo
bold "Select harnesses to register limina into:"
i=0
for k in "${H_KEYS[@]}"; do
  i=$((i+1))
  if detected "$k"; then mark="\033[32m[detected]\033[0m"; else mark="[not found]"; fi
  printf "  %2d) %-22s %b\n" "$i" "${H_LABEL[$k]}" "$mark"
done
echo
if [ -n "${LIMINA_HARNESSES:-}" ]; then
  choice="$LIMINA_HARNESSES"; say "Selection: $choice  (LIMINA_HARNESSES)"
else
  ask "Enter numbers (e.g. 1,3,5), 'all', 'detected', or 'q' to quit: " "detected"; choice="$REPLY"
fi
[ "$choice" = q ] && { say "aborted."; exit 0; }

selected=()
case "$choice" in
  all)      selected=("${H_KEYS[@]}") ;;
  detected) for k in "${H_KEYS[@]}"; do detected "$k" && selected+=("$k") || true; done ;;
  *) IFS=',' read -ra nums <<< "$choice"
     for n in "${nums[@]}"; do n="$(echo "$n" | tr -d ' ')"
       [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#H_KEYS[@]}" ] && selected+=("${H_KEYS[$((n-1))]}") || warn "skip invalid: $n"
     done ;;
esac
[ "${#selected[@]}" -eq 0 ] && { say "nothing selected."; exit 0; }

echo
bold "Plan:"
for k in "${selected[@]}"; do say "  • ${H_LABEL[$k]}"; done
say "  wrapper command: $WRAPPER"
[ "$DRY_RUN" = 1 ] && warn "(dry-run — nothing will be written)"

if [ "$DRY_RUN" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  echo; ask "Apply? [y/N] " "n"; case "$REPLY" in y|Y) ;; *) say "aborted."; exit 0 ;; esac
fi

echo
for k in "${selected[@]}"; do
  bold "→ ${H_LABEL[$k]}"
  write_harness "$k"
done

echo
bold "Done."
cat <<EOF
Next steps:
  • Fully quit & relaunch GUI apps (Claude Desktop, Cursor, Windsurf, LM Studio, Zed) to reload config.
  • Claude Code project servers may need approval: 'claude mcp list'.
  • The server is registered as "$SERVER_NAME"; it grants the 'builder.readWrite' profile.
  • Backups of any edited config were saved alongside as <file>.bak.
EOF
