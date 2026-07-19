//! limina-runtime - Phase 0 embedder.
//!
//! Boots a V8 isolate via deno_core with the WebGPU + ops extensions, loads a
//! TypeScript main module through the transpiling [`TypescriptModuleLoader`],
//! and either runs it to completion (headless) or drives a native window frame
//! loop (windowed). This is the host the agent pillars layer onto later.
//!
//! Usage:
//!   limina <module.ts>                     headless: run the module to completion
//!   limina --window [--frames N] [--width W --height H] [--fullscreen] <mod.ts>
//!                                                windowed: native window + frame loop
//!   limina --mcp-stdio                     stdio JSON-RPC MCP server
//!   limina --mcp-ws [--port N]             WebSocket JSON-RPC MCP server (localhost)

mod mcp_stdio;
mod module_loader;
mod net;
mod windowed;

use std::rc::Rc;

use anyhow::bail;
use deno_core::{resolve_path, JsRuntime, RuntimeOptions};

use module_loader::TypescriptModuleLoader;

#[derive(Debug, PartialEq, Eq)]
struct CliOptions {
    windowed: bool,
    fullscreen: bool,
    mcp_stdio: bool,
    mcp_ws: bool,
    port: u16,
    max_frames: Option<u64>,
    window_width: u32,
    window_height: u32,
    module: String,
}

fn parse_window_dimension(flag: &str, raw: &str) -> anyhow::Result<u32> {
    const MAX_WINDOW_DIMENSION: u32 = 16_384;
    let value = raw.parse::<u32>().map_err(|_| {
        anyhow::anyhow!("{flag} requires an integer in [1, {MAX_WINDOW_DIMENSION}], got '{raw}'")
    })?;
    if value == 0 || value > MAX_WINDOW_DIMENSION {
        bail!("{flag} requires an integer in [1, {MAX_WINDOW_DIMENSION}], got '{raw}'");
    }
    Ok(value)
}

fn parse_cli_args(args: &[String]) -> anyhow::Result<CliOptions> {
    let mut windowed = false;
    let mut fullscreen = false;
    let mut mcp_stdio = false;
    let mut mcp_ws = false;
    let mut port: u16 = 8787;
    let mut max_frames: Option<u64> = None;
    let mut window_width: Option<u32> = None;
    let mut window_height: Option<u32> = None;
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
                let raw = args
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("--port requires a value"))?;
                port = raw.parse::<u16>().map_err(|_| {
                    anyhow::anyhow!("--port requires an integer in [0, 65535], got '{raw}'")
                })?;
            }
            "--frames" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("--frames requires a value"))?;
                max_frames = Some(raw.parse::<u64>().map_err(|_| {
                    anyhow::anyhow!("--frames requires a non-negative integer, got '{raw}'")
                })?);
            }
            "--width" | "--height" => {
                let flag = args[i].clone();
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("{flag} requires a value"))?;
                let value = parse_window_dimension(&flag, raw)?;
                if flag == "--width" {
                    window_width = Some(value);
                } else {
                    window_height = Some(value);
                }
            }
            other if other.starts_with("--") => bail!("unknown option '{other}'"),
            other => {
                if module.replace(other.to_string()).is_some() {
                    bail!("multiple module paths supplied; pass exactly one module");
                }
            }
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
    if !windowed && (window_width.is_some() || window_height.is_some()) {
        bail!("--width and --height require --window");
    }
    if fullscreen && !windowed {
        bail!("--fullscreen requires --window");
    }
    if window_width.is_some() != window_height.is_some() {
        bail!("--width and --height must be supplied together");
    }
    Ok(CliOptions {
        windowed,
        fullscreen,
        mcp_stdio,
        mcp_ws,
        port,
        max_frames,
        window_width: window_width.unwrap_or(960),
        window_height: window_height.unwrap_or(640),
        module,
    })
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let opts = parse_cli_args(&args)?;

    if opts.windowed {
        windowed::run_windowed(
            &opts.module,
            opts.max_frames,
            opts.fullscreen,
            opts.window_width,
            opts.window_height,
        )
    } else if opts.mcp_stdio {
        run_mcp_stdio(&opts.module)
    } else if opts.mcp_ws {
        run_mcp_ws(&opts.module, opts.port)
    } else {
        run_headless(&opts.module)
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

    // JsRuntime::new only registers the isolate in deno_core's global platform
    // registry when an ambient tokio handle exists; without that registration,
    // V8 background threads (async WebAssembly.compile completion) post
    // foreground tasks into the void and their promises never resolve. The
    // tokio context must therefore be entered BEFORE constructing the runtime.
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _tokio_context = tokio_runtime.enter();

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

    tokio_runtime.block_on(fut).map_err(Into::into)
}

/// MCP stdio: load a JS module that owns the SkillRegistry and transport,
/// then expose stdin/stdout ops so external agents exercise JSON-RPC framing.
fn run_mcp_stdio(main_path: &str) -> anyhow::Result<()> {
    // stdout is the JSON-RPC transport in this mode; JS logs must not touch it.
    limina_ops::route_js_logs_to_stderr();
    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
    extensions.push(mcp_stdio::limina_mcp_stdio::init());

    // Tokio context entered before JsRuntime::new — see run_headless.
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _tokio_context = tokio_runtime.enter();

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

    tokio_runtime.block_on(fut).map_err(Into::into)
}

/// MCP WebSocket: bind a localhost TCP listener up front (so clients can connect
/// the instant the process is ready), hand it to the JS module via `OpState`,
/// then run the same JSON-RPC transport loop the stdio path uses. The listener is
/// localhost-only and every launch receives a fresh initialize-handshake token.
fn run_mcp_ws(main_path: &str, port: u16) -> anyhow::Result<()> {
    use std::io::Write as _;

    let mut extensions = limina_render::deno_extensions();
    extensions.push(limina_ops::limina_ops::init());
    extensions.push(limina_physics::limina_physics::init());
    extensions.push(limina_sandbox::limina_sandbox::init());
    extensions.push(limina_ecs::limina_ecs::init());
    extensions.push(limina_audio::limina_audio::init());
    extensions.push(net::limina_net::init());

    // Tokio context entered before JsRuntime::new — see run_headless.
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _tokio_context = tokio_runtime.enter();

    let mut js_runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(TypescriptModuleLoader::new())),
        extensions,
        ..Default::default()
    });

    let main_module = resolve_path(main_path, &std::env::current_dir()?)?;
    let auth_token = generate_ws_auth_token()?;

    let fut = async move {
        // Bind before the JS loop runs: the kernel queues incoming connections
        // in the accept backlog until the JS side calls op_net_accept_host.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let addr = listener.local_addr()?;
        js_runtime
            .op_state()
            .borrow_mut()
            .put(net::WsListener(Rc::new(listener)));
        js_runtime
            .op_state()
            .borrow_mut()
            .put(net::WsAuthToken(auth_token.clone()));

        // Emit a machine-readable ready line so callers can synchronize before
        // connecting (the port is the resolved one, which matters for `--port 0`).
        println!("limina mcp-ws listening on {addr} auth_token={auth_token}");
        std::io::stdout().flush().ok();

        let mod_id = js_runtime.load_main_es_module(&main_module).await?;
        let result = js_runtime.mod_evaluate(mod_id);
        js_runtime.run_event_loop(Default::default()).await?;
        result.await
    };

    tokio_runtime.block_on(fut).map_err(Into::into)
}

fn generate_ws_auth_token() -> anyhow::Result<String> {
    use std::fmt::Write as _;

    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)?;
    let mut token = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut token, "{byte:02x}").expect("writing to String is infallible");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        std::iter::once("limina")
            .chain(items.iter().copied())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn cli_rejects_invalid_port_instead_of_swallowing_module_path() {
        let err = parse_cli_args(&args(&["--port", "foo.ts"]))
            .expect_err("invalid --port value must be rejected");
        assert!(err.to_string().contains("--port"), "{err}");
    }

    #[test]
    fn cli_rejects_missing_flag_values() {
        assert!(parse_cli_args(&args(&["--port"])).is_err());
        assert!(parse_cli_args(&args(&["--frames"])).is_err());
        assert!(parse_cli_args(&args(&["--window", "--width"])).is_err());
        assert!(parse_cli_args(&args(&["--window", "--height"])).is_err());
    }

    #[test]
    fn cli_rejects_unknown_flags_and_multiple_modules() {
        assert!(parse_cli_args(&args(&["--wat"])).is_err());
        assert!(parse_cli_args(&args(&["a.ts", "b.ts"])).is_err());
    }

    #[test]
    fn cli_preserves_defaults_and_valid_options() {
        let opts =
            parse_cli_args(&args(&["--mcp-ws", "--port", "9999"])).expect("valid mcp ws args");
        assert_eq!(opts.port, 9999);
        assert_eq!(opts.module, "js/src/mcp/ws_runtime.ts");
        assert!(opts.mcp_ws);

        let opts = parse_cli_args(&args(&["--window", "--frames", "12", "demo.ts"]))
            .expect("valid window args");
        assert!(opts.windowed);
        assert_eq!(opts.max_frames, Some(12));
        assert_eq!(opts.window_width, 960);
        assert_eq!(opts.window_height, 640);
        assert_eq!(opts.module, "demo.ts");

        let opts = parse_cli_args(&args(&[
            "--window",
            "--width",
            "1600",
            "--height",
            "900",
            "capture.ts",
        ]))
        .expect("valid fixed-size window args");
        assert_eq!(opts.window_width, 1600);
        assert_eq!(opts.window_height, 900);
        assert_eq!(opts.module, "capture.ts");
    }

    #[test]
    fn cli_rejects_invalid_or_headless_window_dimensions() {
        assert!(parse_cli_args(&args(&["--window", "--width", "0", "demo.ts"])).is_err());
        assert!(parse_cli_args(&args(&["--window", "--height", "16385", "demo.ts"])).is_err());
        assert!(parse_cli_args(&args(&["--width", "1600", "demo.ts"])).is_err());
        assert!(parse_cli_args(&args(&["--window", "--width", "1600", "demo.ts"])).is_err());
        assert!(parse_cli_args(&args(&["--window", "--height", "900", "demo.ts"])).is_err());
        assert!(parse_cli_args(&args(&["--fullscreen", "demo.ts"])).is_err());
    }

    #[test]
    fn websocket_auth_tokens_are_256_bit_hex_and_fresh() {
        let first = generate_ws_auth_token().expect("OS random source");
        let second = generate_ws_auth_token().expect("OS random source");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
