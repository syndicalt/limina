# DGX Spark private visual review bridge

This workflow stages only review PNGs into `.limina/review-artifacts/` and serves that directory on
the Spark's IPv4 loopback interface. The server has no route to repository files, credentials,
EventLoom state, or traces. The directory is private (`0700`), staged files are `0600`, symlinks are
ignored, and staging is atomic so partial captures never appear in the gallery.

The gallery displays newest artifacts first and reports each filename, filesystem modification time,
pixel dimensions, byte length, SHA-256, and review state. The approved laptop checkpoint is labeled
by its exact byte identity. Every new Spark capture remains `review required` until the owner reviews
it; matching infrastructure does not transfer visual approval to different pixels.

## Stage the approved checkpoint

From the Limina workspace root:

```bash
node tools/review/dgx-spark-review-bridge.mjs stage \
  assets/qc/internal/temperate-river-leading-line-native-grass-v4.0.1.png \
  --expect-sha256 232e84925ff4fd951159feb6d35a602d04b50ac753bf78e09692582d3304d173 \
  --expect-width 1921 \
  --expect-height 1081
```

For a future guarded capture, first write the capture into `.limina/review-artifacts/` through the
guarded native capture path, or stage a completed PNG with the same command. Never stage a partial
file. Do not use this bridge to serve the source repository or an arbitrary directory.

## Persistent Spark service

The wrapper starts a detached tmux session named `limina-review-bridge`, applies `umask 077`, uses
absolute paths, and verifies the loopback health endpoint. It survives SSH disconnects but not a Spark
reboot.

```bash
tools/review/dgx-spark-review-bridge.sh start
tools/review/dgx-spark-review-bridge.sh status
```

To inspect its private console or deliberately stop it:

```bash
tmux attach-session -t limina-review-bridge
tools/review/dgx-spark-review-bridge.sh stop
```

The default remote port is `4178`. A different port may be selected consistently for the wrapper and
tunnel with `LIMINA_REVIEW_PORT`; the bind address is not configurable and remains `127.0.0.1`.

## Exact laptop tunnel

Run this on the laptop over the private Tailscale SSH route:

```bash
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:4178:127.0.0.1:4178 \
  cheapseatsecon@sparkplug.tail8777de.ts.net
```

Then open `http://127.0.0.1:4178/` on the laptop. Do not add SSH `-g`, use a wildcard local bind, or
publish port 4178 through a router, firewall, reverse proxy, Tailscale Serve/Funnel, or container.

## Verification

```bash
node --test tools/review/dgx-spark-review-bridge.test.mjs
tools/review/dgx-spark-review-bridge.sh status
curl --fail --silent --show-error \
  -H 'Host: 127.0.0.1:4178' \
  http://127.0.0.1:4178/manifest.json
```

`ss` output from `status` must show only `127.0.0.1:4178`, never `0.0.0.0:4178`, `[::]:4178`, or a
LAN/Tailscale address. The bridge deliberately permits only `GET` and `HEAD`, rejects non-loopback Host
headers, serves direct non-hidden PNG basenames only, and emits restrictive browser security headers.
