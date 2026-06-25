//! limina-runtime - Phase 0 embedder.
//!
//! Boots a V8 isolate via deno_core with the WebGPU + ops extensions, loads a
//! TypeScript main module through the transpiling [`TypescriptModuleLoader`],
//! and either runs it to completion (headless) or drives a native window frame
//! loop (windowed). This is the host the agent pillars layer onto later.
//!
//! Usage:
//!   limina <module.ts>                     headless: run the module to completion
//!   limina --window [--frames N] [--fullscreen] <mod.ts>  windowed: native window + frame loop
//!   limina --mcp-stdio                     stdio JSON-RPC MCP server
//!   limina --mcp-ws [--port N]             WebSocket JSON-RPC MCP server (localhost)

mod mcp_stdio;
mod module_loader;
mod net;
mod windowed;

use std::rc::Rc;

use deno_core::{resolve_path, JsRuntime, RuntimeOptions};

use module_loader::TypescriptModuleLoader;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut windowed = false;
    let mut fullscreen = false;
    let mut mcp_stdio = false;
    let mut mcp_ws = false;
    let mut port: u16 = 8787;
    let mut max_frames: Option<u64> = None;
    let mut module: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--window" => windowed = true,
            "--fullscreen" => fullscreen = true,
            "--mcp-stdio" => mcp_stdio = true,
            "--mcp-ws" => mcp_ws = true,
            "--port" => {
                i += 1;
                if let Some(p) = args.get(i).and_then(|s| s.parse::<u16>().ok()) {
                    port = p;
                }
            }
            "--frames" => {
                i += 1;
                max_frames = args.get(i).and_then(|s| s.parse().ok());
            }
            other => module = Some(other.to_string()),
        }
        i += 1;
    }
    let module = module.unwrap_or_else(|| {
        if mcp_stdio {
            "js/src/mcp/stdio_runtime.ts".to_string()
        } else if mcp_ws {
            "js/src/mcp/ws_runtime.ts".to_string()
        } else {
            "js/src/bootstrap.ts".to_string()
        }
    });

    if windowed {
        windowed::run_windowed(&module, max_frames, fullscreen)
    } else if mcp_stdio {
        run_mcp_stdio(&module)
    } else if mcp_ws {
        run_mcp_ws(&module, port)
    } else {
        run_headless(&module)
    }
}

/// Headless: load + evaluate the module, pump the event loop to completion.
fn run_headless(main_path: &str) -> anyhow::Result<()> {
    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
    extensions.push(net::limina_net::init());

    let mut js_runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(TypescriptModuleLoader::new())),
        extensions,
        ..Default::default()
    });

    let main_module = resolve_path(main_path, &std::env::current_dir()?)?;

    let fut = async move {
        let mod_id = js_runtime.load_main_es_module(&main_module).await?;
        // mod_evaluate's future only resolves once the event loop is pumped.
        let result = js_runtime.mod_evaluate(mod_id);
        js_runtime.run_event_loop(Default::default()).await?;
        result.await
    };

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(fut)
        .map_err(Into::into)
}

/// MCP stdio: load a JS module that owns the SkillRegistry and transport,
/// then expose stdin/stdout ops so external agents exercise JSON-RPC framing.
fn run_mcp_stdio(main_path: &str) -> anyhow::Result<()> {
    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
    extensions.push(mcp_stdio::limina_mcp_stdio::init());

    let mut js_runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(TypescriptModuleLoader::new())),
        extensions,
        ..Default::default()
    });

    let main_module = resolve_path(main_path, &std::env::current_dir()?)?;

    let fut = async move {
        let mod_id = js_runtime.load_main_es_module(&main_module).await?;
        let result = js_runtime.mod_evaluate(mod_id);
        js_runtime.run_event_loop(Default::default()).await?;
        result.await
    };

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(fut)
        .map_err(Into::into)
}

/// MCP WebSocket: bind a localhost TCP listener up front (so clients can connect
/// the instant the process is ready), hand it to the JS module via `OpState`,
/// then run the same JSON-RPC transport loop the stdio path uses. Localhost-only
/// and unauthenticated for Phase 2; transport auth is Phase 4.
fn run_mcp_ws(main_path: &str, port: u16) -> anyhow::Result<()> {
    use std::io::Write as _;

    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
    extensions.push(net::limina_net::init());

    let mut js_runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(TypescriptModuleLoader::new())),
        extensions,
        ..Default::default()
    });

    let main_module = resolve_path(main_path, &std::env::current_dir()?)?;

    let fut = async move {
        // Bind before the JS loop runs: the kernel queues incoming connections
        // in the accept backlog until the JS side calls op_net_accept_host.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let addr = listener.local_addr()?;
        js_runtime
            .op_state()
            .borrow_mut()
            .put(net::WsListener(Rc::new(listener)));

        // Emit a machine-readable ready line so callers can synchronize before
        // connecting (the port is the resolved one, which matters for `--port 0`).
        println!("limina mcp-ws listening on {addr}");
        std::io::stdout().flush().ok();

        let mod_id = js_runtime.load_main_es_module(&main_module).await?;
        let result = js_runtime.mod_evaluate(mod_id);
        js_runtime.run_event_loop(Default::default()).await?;
        result.await
    };

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(fut)
        .map_err(Into::into)
}
