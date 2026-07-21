#!/usr/bin/env bash
set -euo pipefail

# Narrow exceptions for dependencies we cannot replace independently. Keep IDs
# explicit so any new advisory still fails the gate.
#
# quick-xml: build-only through winit -> wayland-scanner; it parses the trusted,
# vendored Wayland protocol XML and wayland-scanner 0.31 pins quick-xml ^0.39.
# bincode: deno_core still depends on 1.x; Limina's direct physics decode is
# versioned, byte-bounded, rejects trailing bytes, and validates restored handles.
# paste: transitive procedural-macro dependency through V8/wgpu build tooling.
# ttf-parser: transitive through winit's client-side decoration font renderer.
cargo audit --deny warnings \
  --ignore RUSTSEC-2026-0194 \
  --ignore RUSTSEC-2026-0195 \
  --ignore RUSTSEC-2025-0141 \
  --ignore RUSTSEC-2024-0436 \
  --ignore RUSTSEC-2026-0192
