use deno_core::{extension, op2};
use deno_error::JsErrorBox;
use std::io::{BufRead, Write};

#[op2]
#[string]
fn op_mcp_read_stdin_line() -> Result<String, JsErrorBox> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(JsErrorBox::from_err)?;
    Ok(line)
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
