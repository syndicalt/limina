//! limina-render - WebGPU device + native window surface for the engine.
//!
//! * S3: registers the `deno_webgpu` extension stack + a bootstrap module so
//!   `navigator.gpu` and the global `GPU*` interfaces work in the embedder.
//! * S4: native winit surface injection (Path B) - the host builds a `wgpu`
//!   surface from its own window and hands JS a `GPUCanvasContext` over the same
//!   shared instance, presenting from Rust.

mod surface;

use deno_core::{extension, Extension};
use deno_web::{BlobStore, InMemoryBroadcastChannel};

pub use surface::{FrameCallback, InputState, ResizeCallback, StepCallback, WindowTarget};

extension!(
    limina_bootstrap,
    deps = [deno_webgpu, deno_image],
    ops = [
        surface::op_create_window_context,
        surface::op_surface_present,
        surface::op_surface_resize,
        surface::op_set_frame_callback,
        surface::op_set_resize_callback,
        surface::op_set_fixed_step_callback,
        surface::op_input_axes,
        surface::op_input_look,
    ],
    esm_entry_point = "ext:limina_bootstrap/00_bootstrap.js",
    esm = [dir "js", "00_bootstrap.js"],
);

/// Extensions exposing the standard WebGPU JS API plus limina's surface ops, in
/// dependency order (`deno_webgpu` declares `deps = [deno_webidl, deno_web]`).
/// Append app-specific extensions (ops) after these when building the runtime.
pub fn deno_extensions() -> Vec<Extension> {
    vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            BlobStore::default_arc(),
            None,  // no document location
            false, // CSS parser features off
            InMemoryBroadcastChannel::default(),
        ),
        deno_webgpu::deno_webgpu::init(),
        deno_image::deno_image::init(),
        limina_bootstrap::init(),
    ]
}
