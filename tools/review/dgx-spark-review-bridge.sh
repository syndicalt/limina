#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/cheapseatsecon/Projects/Personal/limina
SERVER="$ROOT/tools/review/dgx-spark-review-bridge.mjs"
SESSION=limina-review-bridge
PORT="${LIMINA_REVIEW_PORT:-4178}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "review bridge: LIMINA_REVIEW_PORT must be an integer from 1024 through 65535" >&2
  exit 2
fi

health() {
  curl --fail --silent --max-time 2 \
    --header "Host: 127.0.0.1:$PORT" \
    "http://127.0.0.1:$PORT/healthz" >/dev/null
}

status() {
  tmux has-session -t "=$SESSION" 2>/dev/null || {
    echo "review bridge: tmux session '$SESSION' is not running" >&2
    return 1
  }
  health || {
    echo "review bridge: tmux exists but loopback health check failed" >&2
    return 1
  }
  tmux list-panes -t "=$SESSION" -F 'session=#{session_name} pid=#{pane_pid} command=#{pane_current_command} dead=#{pane_dead}'
  ss -ltn "sport = :$PORT"
}

case "${1:-}" in
  start)
    if tmux has-session -t "=$SESSION" 2>/dev/null; then
      status
      echo "review bridge: already running"
      exit 0
    fi
    printf -v tmux_command 'umask 077; exec node %q serve --port %q' "$SERVER" "$PORT"
    tmux new-session -d -s "$SESSION" -c "$ROOT" "$tmux_command"
    for _ in {1..30}; do
      if health; then
        status
        echo "Laptop tunnel: ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:$PORT:127.0.0.1:$PORT cheapseatsecon@sparkplug.tail8777de.ts.net"
        echo "Laptop browser: http://127.0.0.1:$PORT/"
        exit 0
      fi
      sleep 0.1
    done
    echo "review bridge: service did not become healthy; inspect with: tmux capture-pane -pt $SESSION" >&2
    exit 1
    ;;
  status)
    status
    ;;
  stop)
    tmux kill-session -t "=$SESSION"
    echo "review bridge: stopped"
    ;;
  *)
    echo "usage: $0 <start|status|stop>" >&2
    exit 2
    ;;
esac
