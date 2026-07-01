use deno_core::{extension, op2};
use deno_error::JsErrorBox;
use std::io::{BufRead, Write};

#[op2]
#[string]
async fn op_mcp_read_stdin_line() -> Result<String, JsErrorBox> {
    // The stdin `read_line` blocks until a full line arrives. Running it inline
    // would block the single V8/event-loop thread, freezing every other async
    // op, timer, and net connection while a slow MCP client dawdles. Push the
    // blocking read onto tokio's blocking pool so the event loop stays live;
    // the line semantics (one call == one newline-terminated line, "" on EOF)
    // are unchanged.
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(JsErrorBox::from_err)?;
        Ok(line)
    })
    .await
    .map_err(|e| JsErrorBox::generic(format!("stdin read task: {e}")))?
}

#[op2(fast)]
fn op_mcp_write_stdout_line(#[string] line: &str) -> Result<(), JsErrorBox> {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(line.as_bytes())
        .map_err(JsErrorBox::from_err)?;
    stdout.write_all(b"\n").map_err(JsErrorBox::from_err)?;
    stdout.flush().map_err(JsErrorBox::from_err)
}

extension!(
    limina_mcp_stdio,
    ops = [op_mcp_read_stdin_line, op_mcp_write_stdout_line],
);
