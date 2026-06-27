//! Windowed mode: native winit window + host-driven fixed-timestep loop (Path B).
//!
//! Single thread owns the V8 isolate, the winit event pump, and surface present.
//! Per frame the host: pumps winit (non-blocking) -> updates input -> runs the
//! JS fixed-step callback N times at a fixed dt (accumulator) -> runs the JS
//! frame (render) callback once -> drains the JS event loop (JS presents via
//! `op_surface_present`). Physics/logic advance on wall-clock time, decoupled
//! from render rate. `CloseRequested`/Escape exits and drains cleanly.

use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

use deno_core::{resolve_path, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{DeviceEvent, DeviceId, ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::window::{CursorGrabMode, Fullscreen, Window, WindowId};

use limina_render::{InputState, WindowTarget};

use crate::module_loader::TypescriptModuleLoader;

const FIXED_DT: f64 = 1.0 / 60.0;
const MAX_STEPS_PER_FRAME: u32 = 5;

#[derive(Default)]
struct App {
    window: Option<Rc<Window>>,
    resized: Option<(u32, u32)>,
    keys: HashSet<KeyCode>,
    close: bool,
    fullscreen: bool,
    /// Mouse-look delta accumulated across winit events since the last frame's
    /// drain; only accumulated while the cursor is grabbed.
    look_dx: f32,
    look_dy: f32,
    /// Cursor grabbed (pointer-locked + hidden) for free-fly look. Toggled by a
    /// left-click (grab) and Escape (release).
    grabbed: bool,
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
                .with_inner_size(LogicalSize::new(960.0, 640.0));
            if self.fullscreen {
                attrs = attrs.with_fullscreen(Some(Fullscreen::Borderless(None)));
            }
            let window = event_loop.create_window(attrs).expect("create window");
            self.window = Some(Rc::new(window));
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
            } => {
                // Click to capture the mouse for free-fly look (no-op if already grabbed).
                if !self.grabbed {
                    self.set_grab(true);
                }
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
) -> anyhow::Result<()> {
    let mut event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App {
        fullscreen,
        ..Default::default()
    };

    while app.window.is_none() {
        event_loop.pump_app_events(Some(Duration::from_millis(16)), &mut app);
    }
    let window = app.window.clone().unwrap();
    let size = window.inner_size();
    let window_handle = window.window_handle()?.as_raw();
    let display_handle = window.display_handle()?.as_raw();

    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
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

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

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
                invoke_callback(&mut js_runtime, Callback::Resize(w, h));
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
            let mut sub = 0;
            while accumulator >= FIXED_DT && sub < MAX_STEPS_PER_FRAME {
                invoke_callback(&mut js_runtime, Callback::Step(FIXED_DT));
                accumulator -= FIXED_DT;
                steps += 1;
                sub += 1;
            }

            // Render once with the leftover interpolation factor.
            let alpha = (accumulator / FIXED_DT) as f32;
            invoke_callback(&mut js_runtime, Callback::Frame(alpha));

            std::future::poll_fn(|cx| {
                js_runtime.poll_event_loop(cx, PollEventLoopOptions::default())
            })
            .await
            .ok();

            frames += 1;
            if max_frames.is_some_and(|max| frames >= max) {
                break;
            }
        }

        // Clean exit: hide window, drain any in-flight async work, then drop.
        window.set_visible(false);
        std::future::poll_fn(|cx| js_runtime.poll_event_loop(cx, PollEventLoopOptions::default()))
            .await
            .ok();

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
fn invoke_callback(js_runtime: &mut JsRuntime, which: Callback) {
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
    let Some(cb) = cb else { return };

    deno_core::scope!(scope, js_runtime);
    v8::tc_scope!(let tc, scope);
    let func = cb.open(tc);
    let recv: v8::Local<v8::Value> = v8::undefined(tc).into();

    let args: Vec<v8::Local<v8::Value>> = match which {
        Callback::Frame(alpha) => vec![v8::Number::new(tc, alpha as f64).into()],
        Callback::Step(dt) => vec![v8::Number::new(tc, dt).into()],
        Callback::Resize(w, h) => vec![
            v8::Number::new(tc, w as f64).into(),
            v8::Number::new(tc, h as f64).into(),
        ],
    };

    func.call(tc, recv, &args);

    if let Some(ex) = tc.exception() {
        let msg = ex.to_rust_string_lossy(tc);
        eprintln!("[limina] callback error: {msg}");
    }
}
