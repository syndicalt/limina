#!/usr/bin/env bash
# Serve the beacon-quest web build so you can view + orbit it live in a browser.
cd "$(dirname "$0")/web" && echo "open http://localhost:8777  (drag-free orbit · WASD/QE to steer the camera)" && exec python3 -m http.server 8777
