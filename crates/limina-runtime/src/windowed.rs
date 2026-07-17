//! Windowed mode: native winit window + host-driven fixed-timestep loop (Path B).
//!
//! Single thread owns the V8 isolate, the winit event pump, and surface present.
//! Per frame the host: pumps winit (non-blocking) -> updates input -> runs the
//! JS fixed-step callback N times at a fixed dt (accumulator) -> runs the JS
//! frame (render) callback once -> advances one bounded JS event-loop turn ->
//! yields to Tokio (JS presents via `op_surface_present`). Physics/logic advance
//! on wall-clock time, decoupled from render rate. Setup and shutdown drain to
//! quiescence; live frames never wait for unrelated host operations.

use std::collections::HashSet;
use std::rc::Rc;
use std::task::Poll;
use std::time::{Duration, Instant};

use deno_core::{resolve_path, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
use winit::event::{DeviceEvent, DeviceId, ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::window::{CursorGrabMode, Fullscreen, Window, WindowId};

use limina_render::{InputState, WindowTarget};

use crate::module_loader::TypescriptModuleLoader;

const FIXED_DT: f64 = 1.0 / 60.0;
const MAX_STEPS_PER_FRAME: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
struct StepBudgetResult {
    steps: u32,
    dropped: f64,
}

fn apply_step_budget(accumulator: &mut f64, fixed_dt: f64, max_steps: u32) -> StepBudgetResult {
    let mut steps = 0;
    while *accumulator >= fixed_dt && steps < max_steps {
        *accumulator -= fixed_dt;
        steps += 1;
    }
    let mut dropped = 0.0;
    if steps == max_steps && *accumulator > fixed_dt {
        dropped = *accumulator - fixed_dt;
        *accumulator = fixed_dt;
    }
    StepBudgetResult { steps, dropped }
}

#[derive(Default)]
struct App {
    window: Option<Rc<Window>>,
    resized: Option<(u32, u32)>,
    keys: HashSet<KeyCode>,
    close: bool,
    fullscreen: bool,
    width: u32,
    height: u32,
    /// Mouse-look delta accumulated across winit events since the last frame's
    /// drain; only accumulated while the cursor is grabbed.
    look_dx: f32,
    look_dy: f32,
    /// Cursor grabbed (pointer-locked + hidden) for free-fly look. Toggled by a
    /// left-click (grab) and Escape (release).
    grabbed: bool,
    /// Window-creation failure captured in `resumed` (the winit handler cannot
    /// return an error); drained by `run_windowed`, which surfaces it as the
    /// startup error instead of a panic inside the event pump.
    init_error: Option<String>,
}

impl App {
    fn input_state(&self) -> InputState {
        let axis = |neg: KeyCode, pos: KeyCode| -> f32 {
            (self.keys.contains(&pos) as i32 - self.keys.contains(&neg) as i32) as f32
        };
        let mut buttons = 0u32;
        if self.keys.contains(&KeyCode::Space) {
            buttons |= limina_render::BUTTON_JUMP;
        }
        if self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight) {
            buttons |= limina_render::BUTTON_RUN;
        }
        InputState {
            move_x: axis(KeyCode::KeyA, KeyCode::KeyD),
            move_y: axis(KeyCode::KeyQ, KeyCode::KeyE),
            move_z: axis(KeyCode::KeyS, KeyCode::KeyW),
            look_dx: self.look_dx,
            look_dy: self.look_dy,
            buttons,
        }
    }

    /// Grab (pointer-lock + hide) or release the cursor for mouse-look. Tries
    /// `Locked` (Wayland) and falls back to `Confined` (X11).
    fn set_grab(&mut self, grab: bool) {
        let Some(window) = &self.window else { return };
        if grab {
            let ok = window
                .set_cursor_grab(CursorGrabMode::Locked)
                .or_else(|_| window.set_cursor_grab(CursorGrabMode::Confined))
                .is_ok();
            if ok {
                window.set_cursor_visible(false);
                self.grabbed = true;
            }
        } else {
            let _ = window.set_cursor_grab(CursorGrabMode::None);
            window.set_cursor_visible(true);
            self.grabbed = false;
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            let mut attrs = Window::default_attributes()
                .with_title("limina")
                .with_inner_size(PhysicalSize::new(self.width, self.height));
            if self.fullscreen {
                attrs = attrs.with_fullscreen(Some(Fullscreen::Borderless(None)));
            }
            match event_loop.create_window(attrs) {
                Ok(window) => self.window = Some(Rc::new(window)),
                Err(e) => {
                    self.init_error = Some(format!("create window: {e}"));
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(&mut self, _event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.close = true,
            WindowEvent::Resized(size) => {
                self.resized = Some((size.width.max(1), size.height.max(1)));
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } if !self.grabbed => {
                // Click to capture the mouse for free-fly look (no-op if already grabbed).
                self.set_grab(true);
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    if code == KeyCode::Escape {
                        // Escape releases the cursor first (so free-fly demos can be
                        // exited safely); a second Escape with no grab closes the window.
                        if self.grabbed {
                            self.set_grab(false);
                        } else {
                            self.close = true;
                        }
                    } else if event.state == ElementState::Pressed {
                        self.keys.insert(code);
                    } else {
                        self.keys.remove(&code);
                    }
                }
            }
            _ => {}
        }
    }

    fn device_event(&mut self, _event_loop: &ActiveEventLoop, _id: DeviceId, event: DeviceEvent) {
        // Raw mouse motion → look delta, accumulated only while grabbed (drained per
        // frame in the host loop). Raw device deltas avoid OS pointer acceleration.
        if let DeviceEvent::MouseMotion { delta } = event {
            if self.grabbed {
                self.look_dx += delta.0 as f32;
                self.look_dy += delta.1 as f32;
            }
        }
    }
}

pub fn run_windowed(
    main_path: &str,
    max_frames: Option<u64>,
    fullscreen: bool,
    width: u32,
    height: u32,
) -> anyhow::Result<()> {
    let mut event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App {
        fullscreen,
        width,
        height,
        ..Default::default()
    };

    while app.window.is_none() {
        let status = event_loop.pump_app_events(Some(Duration::from_millis(16)), &mut app);
        if let Some(err) = app.init_error.take() {
            anyhow::bail!("windowed startup failed: {err}");
        }
        if matches!(status, PumpStatus::Exit(_)) || app.close {
            anyhow::bail!("window closed before startup completed");
        }
    }
    let window = match app.window.clone() {
        Some(window) => window,
        None => anyhow::bail!("windowed startup did not produce a window"),
    };
    // X11 can return a requested inner size as soon as create_window succeeds while the native
    // surface is not presentable until the compositor's post-create ConfigureNotify is pumped.
    // Setup modules such as the guarded fidelity capture render during module evaluation, before
    // the normal host loop below gets a chance to drain that event. Settle one bounded initial
    // configure boundary here and publish its compositor-confirmed physical size to WebGPU.
    let mut configured_size = app.resized.take();
    for _ in 0..2_000 {
        let status = event_loop.pump_app_events(Some(Duration::from_millis(16)), &mut app);
        if matches!(status, PumpStatus::Exit(_)) || app.close {
            anyhow::bail!("window closed before its initial surface configuration completed");
        }
        if let Some(size) = app.resized.take() {
            configured_size = Some(size);
        }
        if configured_size.is_some_and(|(configured_width, configured_height)| {
            !fullscreen || (configured_width >= width && configured_height >= height)
        }) {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let (configured_width, configured_height) = configured_size
        .ok_or_else(|| anyhow::anyhow!("window did not report an initial surface configuration"))?;
    let size = PhysicalSize::new(configured_width.max(1), configured_height.max(1));
    let window_handle = window.window_handle()?.as_raw();
    let display_handle = window.display_handle()?.as_raw();

    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());

    // JsRuntime::new only registers the isolate in deno_core's global platform
    // registry when an ambient tokio handle exists; without it, V8 background
    // threads (async WebAssembly.compile completion) post foreground tasks into
    // the void. Enter the tokio context BEFORE constructing the runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _tokio_context = rt.enter();

    let mut js_runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(TypescriptModuleLoader::new())),
        extensions,
        ..Default::default()
    });

    {
        let op_state = js_runtime.op_state();
        op_state.borrow_mut().put(WindowTarget {
            window_handle,
            display_handle,
            width: size.width.max(1),
            height: size.height.max(1),
        });
    }

    let main_module = resolve_path(main_path, &std::env::current_dir()?)?;

    rt.block_on(async move {
        // Evaluate the setup module: device + surface + callback registration.
        let mod_id = js_runtime.load_main_es_module(&main_module).await?;
        let eval = js_runtime.mod_evaluate(mod_id);
        js_runtime.run_event_loop(Default::default()).await?;
        eval.await?;

        let start = Instant::now();
        let mut last = Instant::now();
        let mut accumulator: f64 = 0.0;
        let mut frames: u64 = 0;
        let mut steps: u64 = 0;

        loop {
            let status = event_loop.pump_app_events(Some(Duration::ZERO), &mut app);
            if matches!(status, PumpStatus::Exit(_)) || app.close {
                break;
            }

            if let Some((w, h)) = app.resized.take() {
                invoke_callback(&mut js_runtime, Callback::Resize(w, h))?;
            }

            // Refresh input axes for JS to read this frame.
            {
                let op_state = js_runtime.op_state();
                op_state.borrow_mut().put(app.input_state());
            }
            // Drain the accumulated mouse-look delta now that it's been published for
            // this frame (the put copied it into op_state; JS reads that copy).
            app.look_dx = 0.0;
            app.look_dy = 0.0;

            // Fixed-timestep accumulator: advance logic on wall-clock time.
            let now = Instant::now();
            let dt = (now - last).as_secs_f64().min(0.25);
            last = now;
            accumulator += dt;
            let budget = apply_step_budget(&mut accumulator, FIXED_DT, MAX_STEPS_PER_FRAME);
            for _ in 0..budget.steps {
                invoke_callback(&mut js_runtime, Callback::Step(FIXED_DT))?;
                steps += 1;
            }
            if budget.dropped > 0.0 {
                eprintln!(
                    "[limina] windowed loop dropped {:.3}ms of fixed-step debt after hitting {MAX_STEPS_PER_FRAME} steps/frame",
                    budget.dropped * 1000.0,
                );
            }

            // Render once with the leftover interpolation factor.
            let alpha = (accumulator / FIXED_DT) as f32;
            invoke_callback(&mut js_runtime, Callback::Frame(alpha))?;

            // Advance host ops/promises without waiting for every pending operation to finish.
            // Fully draining here serializes the real-time loop against GPU readbacks, streaming,
            // and network I/O. The loop polls continuously, while setup and shutdown still drain.
            std::future::poll_fn(|cx| {
                Poll::Ready(match js_runtime.poll_event_loop(cx, PollEventLoopOptions::default()) {
                    Poll::Ready(result) => result,
                    Poll::Pending => Ok(()),
                })
            })
            .await?;
            // `run_windowed` owns a current-thread Tokio runtime. The bounded Deno poll above is
            // deliberately always ready, so yield explicitly to let Tokio drive GPU mappings,
            // timers, sockets, and other host futures before the next frame starts.
            tokio::task::yield_now().await;

            frames += 1;
            if max_frames.is_some_and(|max| frames >= max) {
                break;
            }
        }

        // Clean exit: hide window, drain any in-flight async work, then drop.
        window.set_visible(false);
        std::future::poll_fn(|cx| js_runtime.poll_event_loop(cx, PollEventLoopOptions::default()))
            .await?;

        let elapsed = start.elapsed().as_secs_f64();
        println!(
            "[limina] exit: {frames} frames, {steps} fixed steps, {elapsed:.2}s \
             ({:.1} fps, {:.1} steps/s vs {:.1} target)",
            frames as f64 / elapsed,
            steps as f64 / elapsed,
            1.0 / FIXED_DT,
        );
        Ok::<(), anyhow::Error>(())
    })
}

enum Callback {
    Frame(f32),
    Step(f64),
    Resize(u32, u32),
}

/// Invoke a registered JS callback inside a `TryCatch` so a thrown error is
/// surfaced (logged) rather than silently swallowed.
fn invoke_callback(js_runtime: &mut JsRuntime, which: Callback) -> anyhow::Result<()> {
    use limina_render::{FrameCallback, ResizeCallback, StepCallback};

    let cb = {
        let op_state = js_runtime.op_state();
        let op_state = op_state.borrow();
        match which {
            Callback::Frame(_) => op_state.try_borrow::<FrameCallback>().map(|c| c.0.clone()),
            Callback::Step(_) => op_state.try_borrow::<StepCallback>().map(|c| c.0.clone()),
            Callback::Resize(..) => op_state.try_borrow::<ResizeCallback>().map(|c| c.0.clone()),
        }
    };
    let Some(cb) = cb else { return Ok(()) };

    deno_core::scope!(scope, js_runtime);
    v8::tc_scope!(let tc, scope);
    let func = cb.open(tc);
    let recv: v8::Local<v8::Value> = v8::undefined(tc).into();

    let called = match which {
        Callback::Frame(alpha) => {
            let args = [v8::Number::new(tc, alpha as f64).into()];
            func.call(tc, recv, &args)
        }
        Callback::Step(dt) => {
            let args = [v8::Number::new(tc, dt).into()];
            func.call(tc, recv, &args)
        }
        Callback::Resize(w, h) => {
            let args = [
                v8::Number::new(tc, w as f64).into(),
                v8::Number::new(tc, h as f64).into(),
            ];
            func.call(tc, recv, &args)
        }
    };
    if called.is_none() {
        let message = tc
            .exception()
            .map(|exception| exception.to_rust_string_lossy(tc))
            .unwrap_or_else(|| {
                "callback returned no value after an unknown V8 failure".to_string()
            });
        anyhow::bail!("windowed JavaScript callback failed: {message}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_budget_drops_excess_time_debt_after_stall() {
        let mut accumulator = 0.25;
        let applied = apply_step_budget(&mut accumulator, FIXED_DT, MAX_STEPS_PER_FRAME);
        assert_eq!(applied.steps, MAX_STEPS_PER_FRAME);
        assert!(
            applied.dropped > 0.0,
            "stall debt beyond the frame budget must be reported"
        );
        assert!(
            accumulator <= FIXED_DT,
            "leftover accumulator {} must not produce alpha > 1",
            accumulator,
        );
    }

    #[test]
    fn step_budget_preserves_normal_remainder_without_dropping() {
        let mut accumulator = FIXED_DT * 2.25;
        let applied = apply_step_budget(&mut accumulator, FIXED_DT, MAX_STEPS_PER_FRAME);
        assert_eq!(applied.steps, 2);
        assert_eq!(applied.dropped, 0.0);
        assert!((accumulator - FIXED_DT * 0.25).abs() < 1e-12);
    }
}
