#!/usr/bin/env bash
# P4.0c netcode spike -- reproduce. Builds the detached workspace, runs the two
# real processes (authoritative server + client) over a real localhost socket,
# then runs the real-engine WS baseline against the unmodified `limina` binary.
#
#   ./run.sh [ROUNDS] [ENGINE_ROUNDS]
#
# Outputs land in results/: client.out (model p95 + authority), server.out
# (authority rejections printed by the server), server_worldlog.jsonl (the
# recorded authoritative command stream), engineprobe.out (real-engine baseline).
set -euo pipefail
cd "$(dirname "$0")"

ROUNDS="${1:-2000}"
ENGINE_ROUNDS="${2:-1000}"
REPO_ROOT="$(cd ../.. && pwd)"
LIMINA="$REPO_ROOT/target/debug/limina"

echo "== building (release) =="
cargo build --release

mkdir -p results
rm -f results/server.addr

echo "== model: authoritative server + client (two real processes, real socket) =="
./target/release/netcode-server --port 0 --addr-file results/server.addr \
  --log results/server_worldlog.jsonl --entities 8 > results/server.out 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 200); do [ -s results/server.addr ] && break; sleep 0.05; done
ADDR="$(cat results/server.addr)"
echo "server pid=$SRV listening on $ADDR"

./target/release/netcode-client --addr "$ADDR" --rounds "$ROUNDS" --out results/client.out
echo
echo "-- authority rejections printed by the SERVER (results/server.out) --"
grep REJECT results/server.out || true
echo "-- world log (recorded authoritative command stream) --"
echo "lines: $(wc -l < results/server_worldlog.jsonl)  (meta + seed + one skill cmd per accepted intent)"
head -1 results/server_worldlog.jsonl
kill $SRV 2>/dev/null || true
trap - EXIT

echo
if [ -x "$LIMINA" ]; then
  echo "== engine baseline: real \`limina --mcp-ws\` over a real WebSocket =="
  ./target/release/netcode-engineprobe --limina "$LIMINA" --cwd "$REPO_ROOT" \
    --rounds "$ENGINE_ROUNDS" --out results/engineprobe.out || echo "engineprobe failed (non-fatal)"
else
  echo "== engine baseline SKIPPED: $LIMINA not found (run \`cargo build\` at repo root) =="
fi
echo
echo "== done. see results/ =="
