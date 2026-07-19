const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * A loopback bind is not an HTTP trust boundary: DNS rebinding can deliver a
 * hostile Host header to 127.0.0.1. Accept only the exact public endpoints this
 * process advertises, including the actual listening port.
 */
export function isAllowedLoopbackRequestHost(rawHost, expectedPort) {
  if (typeof rawHost !== "string" || !Number.isInteger(expectedPort)
      || expectedPort < 1 || expectedPort > 65_535) return false;
  let parsed;
  try { parsed = new URL(`http://${rawHost}`); }
  catch { return false; }
  return parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.port === String(expectedPort)
    && LOOPBACK_HOSTS.has(parsed.hostname);
}
