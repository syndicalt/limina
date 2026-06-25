# Phase 3 Textured glTF Headless Note

Status: implemented for sandboxed assets; not a general browser/network surface.

`three.loadGLTF` now records parsed glTF resource metadata in headless tests using the existing `GLTFLoader.parse` path. The checked-in fixture `assets/textured-triangle.gltf` contains an embedded PNG texture and proves loader integration, image decode via `createImageBitmap`, material texture wiring, asset byte accounting, scene graph traversal, and lifecycle tracking.

The runtime now exposes a deliberately narrow asset-only web loading shim: `fetch`, `Request`, `Headers`, `Response`, `Blob`, `URL`, `atob`/`btoa`, `createImageBitmap`, and `ImageBitmap`. Fetch is not a network API. It supports data URLs, relative asset ids, and `limina-asset://<relative-id>` routed through `op_read_asset`, preserving the existing asset-root sandbox.

Verification:

- `target/debug/limina js/test/p3_textured_gltf.ts`
- `target/debug/limina --window --frames 5 js/test/p3_textured_gltf_window.ts`

The implementation still does not claim arbitrary web fetching, DOM image elements, or network-loaded glTF assets.
