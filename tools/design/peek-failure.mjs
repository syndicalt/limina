const STRUCTURAL_FAILURE = /FATAL: peek invalid\s*[—-]\s*structural command\(s\) failed:\s*([^\r\n]+)/i;
const NULL_FAILURE = /FATAL: peek invalid\s*[—-]\s*runLive returned null/i;

function boundedLine(value, maximum = 320) {
  const line = String(value).replace(/\s+/g, " ").trim();
  if (line.length <= maximum) return line;
  const prefix = line.slice(0, maximum - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary >= maximum / 2 ? boundary : prefix.length).trimEnd()}…`;
}

export function summarizePeekFailure({ timedOut = false, code, output = "" } = {}) {
  if (timedOut) return "3D preview renderer timed out";
  const structural = String(output).match(STRUCTURAL_FAILURE)?.[1];
  if (structural) {
    const deduplicated = structural.replace(/\b([A-Za-z][\w.-]+):\s+\1:\s+/g, "$1: ");
    return `3D preview could not build the scene: ${boundedLine(deduplicated)}`;
  }
  if (NULL_FAILURE.test(String(output))) return "3D preview could not build the scene";
  if (code === 0) return "3D preview renderer produced no frames";
  return `3D preview renderer failed${Number.isInteger(code) ? ` (exit ${code})` : ""}`;
}
