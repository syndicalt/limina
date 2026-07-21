use deno_core::{extension, op2};
use deno_error::JsErrorBox;
use std::io::{BufRead, Write};

const MAX_MCP_STDIO_LINE_BYTES: usize = 1024 * 1024;

fn read_stdin_line_bounded<R: BufRead>(reader: &mut R) -> Result<String, JsErrorBox> {
    let mut bytes = Vec::with_capacity(4096);
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().map_err(JsErrorBox::from_err)?;
        if available.is_empty() {
            break;
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |i| i + 1);
        if !oversized && bytes.len().saturating_add(take) <= MAX_MCP_STDIO_LINE_BYTES {
            bytes.extend_from_slice(&available[..take]);
        } else {
            oversized = true;
        }
        let ended = available[take - 1] == b'\n';
        reader.consume(take);
        if ended {
            break;
        }
    }
    if oversized {
        return Err(JsErrorBox::generic(format!(
            "mcp stdio line exceeds {MAX_MCP_STDIO_LINE_BYTES} byte cap"
        )));
    }
    String::from_utf8(bytes).map_err(|_| JsErrorBox::generic("mcp stdio line is not valid UTF-8"))
}

#[op2]
#[string]
async fn op_mcp_read_stdin_line() -> Result<String, JsErrorBox> {
    // The stdin `read_line` blocks until a full line arrives. Running it inline
    // would block the single V8/event-loop thread, freezing every other async
    // op, timer, and net connection while a slow MCP client dawdles. Push the
    // blocking read onto tokio's blocking pool so the event loop stays live;
    // the line semantics (one call == one newline-terminated line, "" on EOF)
    // are unchanged.
    //
    // SHUTDOWN CONSTRAINT: a blocking stdin read cannot be cancelled, so while a
    // read is pending this op keeps `run_event_loop` from completing — the
    // process exits only when the client closes stdin (EOF) or sends a final
    // line. Releasing that requires the JS transport to unref the pending read
    // promise (`Deno.core.unrefOpPromise` in js/src/mcp/stdio_runtime.ts); it is
    // not fixable from this op alone.
    tokio::task::spawn_blocking(|| read_stdin_line_bounded(&mut std::io::stdin().lock()))
        .await
        .map_err(|e| JsErrorBox::generic(format!("stdin read task: {e}")))?
}

#[op2]
async fn op_mcp_write_stdout_line(#[string] line: String) -> Result<(), JsErrorBox> {
    tokio::task::spawn_blocking(move || {
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(line.as_bytes())
            .map_err(JsErrorBox::from_err)?;
        stdout.write_all(b"\n").map_err(JsErrorBox::from_err)?;
        stdout.flush().map_err(JsErrorBox::from_err)
    })
    .await
    .map_err(|e| JsErrorBox::generic(format!("stdout write task: {e}")))?
}

extension!(
    limina_mcp_stdio,
    ops = [op_mcp_read_stdin_line, op_mcp_write_stdout_line],
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn stdio_read_line_rejects_oversized_frames() {
        let oversized = format!("{}\n", "x".repeat(MAX_MCP_STDIO_LINE_BYTES + 1));
        let mut input = Cursor::new(oversized.into_bytes());
        let err = read_stdin_line_bounded(&mut input).unwrap_err();
        assert!(
            err.to_string().contains("line exceeds"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn stdio_read_line_accepts_bounded_frames() {
        let line = "{\"jsonrpc\":\"2.0\",\"id\":1}\n";
        let mut input = Cursor::new(line.as_bytes());
        let got = read_stdin_line_bounded(&mut input).unwrap();
        assert_eq!(got, line);
    }

    #[test]
    fn oversized_line_is_fully_drained_before_next_frame() {
        let bytes = format!("{}\nnext\n", "x".repeat(MAX_MCP_STDIO_LINE_BYTES + 1)).into_bytes();
        let mut input = Cursor::new(bytes);
        assert!(read_stdin_line_bounded(&mut input).is_err());
        assert_eq!(read_stdin_line_bounded(&mut input).unwrap(), "next\n");
    }
}
