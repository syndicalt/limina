# limina studio shell

The studio editor as a desktop app: the same web UI you get at
`http://localhost:5173/`, wrapped in Electron with **pinned GPU behavior** so
browser GPU roulette stops being part of the workflow.

## Why

- **Dual-GPU laptops (Optimus/PRIME):** Chrome picks the integrated GPU by
  default. The shell forces the high-performance GPU
  (`--force_high_performance_gpu`) — pair it with the PRIME offload env below
  for a deterministic dGPU.
- **Hosts with broken WebGPU (e.g. GB10):** browsers gate WebGPU behind secure
  contexts and driver heuristics you cannot override. The shell enables WebGPU
  by flag and (optionally) marks a plain-http LAN origin as secure, so the
  decision is yours, not the browser's.

## Run

```bash
cd tools/studio-shell
npm install          # one time (downloads Electron)
npm start
```

Point it at any studio stack (default `http://localhost:5173/`):

```bash
# SSH tunnel to a remote stack (spark/GB10), recommended for now:
ssh -L 5173:localhost:5173 -L 8787:localhost:8787 -L 5174:127.0.0.1:5174 you@spark
npm start

# LAN stack directly:
LIMINA_STUDIO_URL=http://192.168.1.50:5173/ LIMINA_STUDIO_INSECURE_ORIGIN=1 npm start

# NVIDIA PRIME offload on a dual-GPU Linux laptop:
__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia npm start
```

## Trust boundary

`LIMINA_STUDIO_INSECURE_ORIGIN=1` tells Chromium to treat a plain-http origin
as a secure context (enables SharedArrayBuffer + WebGPU there). Only use it
for stacks you control — it is the same trust decision as the SSH tunnel it
replaces. The shell runs the studio with `sandbox: true`, no Node integration,
and blocks popups to external origins.
