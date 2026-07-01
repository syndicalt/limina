#!/usr/bin/env bash
# llmff op:tool shim — runs the REAL limina functional gate for a slice and emits ONLY the JSON
# verdict on stdout (so llmff's validate_json stage can consume it). Self-locating: resolves the
# repo root from its own path, so it works regardless of llmff's working directory.
#
# The codegen text llmff pipes on stdin is consumed + ignored (in production it would be the written
# game code; here the gate runs the reference game). SLICE_GATE_SCRIPT selects the passing or broken
# gate (for the falsifiability check).
set -euo pipefail
# llmff runs tool commands with a minimal environment; restore a usable PATH so the coreutils +
# the limina binary resolve.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Drain stdin (the upstream codegen output) without failing if it's empty/closed.
cat >/dev/null 2>&1 || true

# Per-run nonce: the gate stamps its verdict line with this unpredictable value so a STATICALLY
# pre-printed sentinel (one baked into game text, which can't know the nonce) is NOT mistaken for the
# gate's real result. NOTE: the nonce is carried in traces/slice-target, which in-VM game code can
# also read via op_read_trace (a sandbox-readable op) — so untrusted code CAN learn the nonce and
# forge a matching line. That path is closed only partially here (see the tail -1 note below).
#
# DECISION (resolved-as-designed): full unforgeability is NOT pursued via a transport trick, because
# the game code and this gate share ONE VM and ONE op surface — any channel the gate can write (stdout,
# op_write_trace, a host-only op, a hard-exit op), in-VM game code can write too, so no transport is
# host-only. The real fix is TRUST-DOMAIN SEPARATION: run game.build() without the verdict ops (the
# engine's QuickJS-isolation model). That is deliberately deferred to WHEN untrusted, agent-generated
# game code is actually executed through this gate — TODAY the codegen on stdin is discarded (above) and
# the gate runs a TRUSTED first-party reference game, so nonce + tail-1 is proportionate to the real
# threat (buggy, not adversarial, codegen). Do not add a transport-layer "fix" — it would be theater.
# Exported for env-capable hosts; also carried in the target trace for the native runtime, which
# exposes no env API.
NONCE="$(openssl rand -hex 8 2>/dev/null || echo $RANDOM$RANDOM$$)"
export SLICE_VERDICT_NONCE="$NONCE"

# Validate the slice game id BEFORE interpolating it into the JSON trace below: reject anything with a
# character outside [A-Za-z0-9._-] so a crafted value can't inject extra JSON fields. Normalize the
# broken flag to a strict boolean for the same reason.
GAME_ID="${SLICE_GAME_ID:-relic-sprint}"
case "$GAME_ID" in
  ""|*[!A-Za-z0-9._-]*) echo "run-slice-gate: refusing invalid SLICE_GAME_ID '$GAME_ID'" >&2; exit 1;;
esac
case "${SLICE_BROKEN:-false}" in
  true) BROKEN=true;;
  *)    BROKEN=false;;
esac

# Write the slice's target (game + broken flag + nonce) into a trace the sandboxed gate reads (op_read_trace).
mkdir -p "$ROOT/traces"
printf '{"gameId":"%s","broken":%s,"nonce":"%s"}' "$GAME_ID" "$BROKEN" "$NONCE" > "$ROOT/traces/slice-target"
OUT="$(cd "$ROOT" && ./target/release/limina js/scripts/slice-gate.ts 2>/dev/null || true)"

# Accept ONLY the verdict lines carrying THIS run's nonce, then strip the nonced sentinel → bare JSON.
# A statically pre-printed sentinel can't match the unpredictable nonce. In-VM code that read the
# nonce from the target trace COULD emit a matching line, but the gate emits its own verdict LAST, so
# tail -1 selects the gate's final emit over any earlier forged line. (This is a mitigation, not a
# guarantee — see the nonce note above for the honest limitation.)
echo "$OUT" | grep -o "__SLICE_VERDICT__${NONCE}__.*" | sed "s/__SLICE_VERDICT__${NONCE}__//" | tail -1
