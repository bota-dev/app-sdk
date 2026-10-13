//! Differential CI helper: one shared native engine, one response per JSON line.
#[cfg(not(target_arch = "wasm32"))]
fn main() -> std::io::Result<()> {
    use bota_device_sdk_js::{MAX_MESSAGE_BYTES, TraceEngine};
    use std::io::{BufRead, Read, Write};
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut engine = TraceEngine::default();
    loop {
        let mut line = Vec::new();
        let read = input
            .by_ref()
            .take((MAX_MESSAGE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        // An oversized line is one rejected request, not multiple RPC fragments.
        if line.len() > MAX_MESSAGE_BYTES && line.last() != Some(&b'\n') {
            loop {
                let bytes = input.fill_buf()?;
                if bytes.is_empty() {
                    break;
                }
                let newline = bytes.iter().position(|byte| *byte == b'\n');
                let consumed = newline.map_or(bytes.len(), |index| index + 1);
                input.consume(consumed);
                if newline.is_some() {
                    break;
                }
            }
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        output.write_all(&engine.request(&line))?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}
