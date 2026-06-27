//! Native window surface injection (Path B).
//!
//! The Rust host owns the winit window; these ops build a `wgpu` surface from
//! its raw handle using the SAME shared instance `navigator.gpu` uses
//! (`deno_webgpu`'s `Instance` in `OpState`), wrap it as a `GPUCanvasContext`
//! via `deno_webgpu::canvas::create`, and present it from Rust. No FFI, no
//! `deno_canvas` — the host owns window + device + surface, matching limina's
//! settled architecture.

use std::cell::RefCell;
use std::rc::Rc;

use deno_core::{op2, v8, OpState};
use deno_error::JsErrorBox;
use deno_webgpu::canvas::{self, ContextData, GPUCanvasContext, SurfaceData};
use deno_webgpu::Instance;
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

/// Raw handles of the host window, placed in `OpState` before JS runs so the
/// surface op can build a wgpu surface from the window the host owns.
pub struct WindowTarget {
    pub window_handle: RawWindowHandle,
    pub display_handle: RawDisplayHandle,
    pub width: u32,
    pub height: u32,
}

/// Present state: the shared wgpu instance + the surface created for the window.
/// The `Rc` is shared with the `GPUCanvasContext`, so resizing here is observed
/// by the context's `configure`/`getCurrentTexture`.
struct SurfacePresenter {
    instance: Instance,
    surface: Rc<RefCell<SurfaceData>>,
}

/// JS per-frame callback, invoked by the host loop each iteration.
pub struct FrameCallback(pub v8::Global<v8::Function>);

/// JS resize callback (reconfigures the surface), invoked on window resize.
pub struct ResizeCallback(pub v8::Global<v8::Function>);

/// JS fixed-timestep callback, invoked N times per frame at a fixed dt.
pub struct StepCallback(pub v8::Global<v8::Function>);

/// Movement axes derived from the host's keyboard state, refreshed each frame.
/// JS reads them via `op_input_axes` to drive the camera.
#[derive(Default, Clone, Copy)]
pub struct InputState {
    pub move_x: f32,
    pub move_y: f32,
    pub move_z: f32,
    /// Mouse-look delta (raw device units) accumulated since the last frame and
    /// drained by the host each frame; zero unless the cursor is grabbed. JS reads
    /// it via `op_input_look` to drive a free-fly / FPS camera.
    pub look_dx: f32,
    pub look_dy: f32,
}

/// Create the window's `GPUCanvasContext`. Must be called from JS after
/// `navigator.gpu.requestAdapter()` (which creates the shared `Instance`).
#[op2]
pub fn op_create_window_context<'s>(
    state: &mut OpState,
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Global<v8::Value>, JsErrorBox> {
    let instance = state
        .try_borrow::<Instance>()
        .ok_or_else(|| {
            JsErrorBox::generic("WebGPU instance missing - call requestAdapter() first")
        })?
        .clone();

    let (window_handle, display_handle, width, height) = {
        let target = state
            .try_borrow::<WindowTarget>()
            .ok_or_else(|| JsErrorBox::generic("no WindowTarget (running headless?)"))?;
        (
            target.window_handle,
            target.display_handle,
            target.width,
            target.height,
        )
    };

    // SAFETY: the host owns the window for the whole program; the raw handles
    // stay valid until shutdown, well past any surface use.
    let surface_id =
        unsafe { instance.instance_create_surface(Some(display_handle), window_handle, None) }
            .map_err(|e| JsErrorBox::generic(format!("create surface: {e}")))?;

    let surface = Rc::new(RefCell::new(SurfaceData {
        width,
        height,
        id: surface_id,
        instance: instance.clone(),
    }));
    state.put(SurfacePresenter {
        instance: instance.clone(),
        surface: surface.clone(),
    });

    let canvas_obj = v8::Object::new(scope);
    let canvas_global = v8::Global::new(scope, canvas_obj);
    let options: v8::Local<v8::Value> = v8::undefined(scope).into();
    canvas::create(
        Some(instance),
        canvas_global,
        ContextData::Surface(surface),
        scope,
        options,
        "limina",
        "createWindowContext",
    )
}

/// Present the current swapchain image and clear the context's cached texture so
/// the next `getCurrentTexture()` acquires a fresh one (this is what Deno's own
/// `UnsafeWindowSurface.present` does).
#[op2(fast)]
pub fn op_surface_present(
    state: &mut OpState,
    #[cppgc] context: &GPUCanvasContext,
) -> Result<(), JsErrorBox> {
    let (instance, surface_id) = {
        let presenter = state
            .try_borrow::<SurfacePresenter>()
            .ok_or_else(|| JsErrorBox::generic("surface not created"))?;
        (presenter.instance.clone(), presenter.surface.borrow().id)
    };
    instance
        .surface_present(surface_id)
        .map_err(|e| JsErrorBox::generic(format!("present: {e}")))?;
    context.current_texture.borrow_mut().take();
    Ok(())
}

/// Update the surface dimensions after a window resize. JS must then re-call
/// `context.configure(...)` (which reads these dims) to reconfigure the swapchain.
#[op2(fast)]
pub fn op_surface_resize(state: &mut OpState, width: u32, height: u32) {
    if let Some(presenter) = state.try_borrow::<SurfacePresenter>() {
        let mut surface = presenter.surface.borrow_mut();
        surface.width = width;
        surface.height = height;
    }
}

/// Register the JS function the host loop invokes each frame.
#[op2]
pub fn op_set_frame_callback(state: &mut OpState, #[scoped] cb: v8::Global<v8::Function>) {
    state.put(FrameCallback(cb));
}

/// Register the JS function the host invokes when the window is resized.
#[op2]
pub fn op_set_resize_callback(state: &mut OpState, #[scoped] cb: v8::Global<v8::Function>) {
    state.put(ResizeCallback(cb));
}

/// Register the JS function the host invokes N times per frame at a fixed dt.
#[op2]
pub fn op_set_fixed_step_callback(state: &mut OpState, #[scoped] cb: v8::Global<v8::Function>) {
    state.put(StepCallback(cb));
}

/// Write the current movement axes into `out[0..3]` (x = strafe, y = up,
/// z = forward), as set by the host from keyboard state. Zero when unset.
#[op2(fast)]
pub fn op_input_axes(state: &mut OpState, #[buffer] out: &mut [f32]) {
    if out.len() < 3 {
        return;
    }
    let input = state
        .try_borrow::<InputState>()
        .copied()
        .unwrap_or_default();
    out[0] = input.move_x;
    out[1] = input.move_y;
    out[2] = input.move_z;
}

/// Write the mouse-look delta into `out[0..2]` (dx, dy in raw device units),
/// accumulated by the host since the last frame; zero when the cursor isn't
/// grabbed. Drives a free-fly / FPS camera (yaw += dx, pitch += dy).
#[op2(fast)]
pub fn op_input_look(state: &mut OpState, #[buffer] out: &mut [f32]) {
    if out.len() < 2 {
        return;
    }
    let input = state
        .try_borrow::<InputState>()
        .copied()
        .unwrap_or_default();
    out[0] = input.look_dx;
    out[1] = input.look_dy;
}
