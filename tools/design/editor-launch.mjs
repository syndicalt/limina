export function editorLaunchConfigFromEnvironment(environment = process.env) {
  const input = environment.LIMINA_EDITOR_HANDOFF_URL;
  const atlasInput = environment.LIMINA_ATLAS_PUBLIC_ORIGIN;
  if ((input === undefined || input === "") && (atlasInput === undefined || atlasInput === "")) return undefined;
  if (typeof input !== "string" || input === "" || typeof atlasInput !== "string" || atlasInput === "") {
    throw new Error("LIMINA_EDITOR_HANDOFF_URL and LIMINA_ATLAS_PUBLIC_ORIGIN must be configured together");
  }
  let handoff;
  let atlas;
  try { handoff = new URL(input); atlas = new URL(atlasInput); }
  catch (error) { throw new Error(`LIMINA_EDITOR_HANDOFF_URL is invalid: ${error.message}`); }
  if (handoff.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(handoff.hostname)
      || handoff.port === "" || handoff.pathname !== "/atlas-handoff.html" || handoff.search !== ""
      || handoff.hash !== "" || handoff.username !== "" || handoff.password !== ""
      || handoff.href !== input) {
    throw new Error("LIMINA_EDITOR_HANDOFF_URL must be an exact loopback http URL ending in /atlas-handoff.html");
  }
  if (atlas.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(atlas.hostname)
      || atlas.port === "" || atlas.origin !== atlasInput || atlas.username !== "" || atlas.password !== "") {
    throw new Error("LIMINA_ATLAS_PUBLIC_ORIGIN must be an exact loopback http origin");
  }
  return Object.freeze({ handoffUrl: handoff.href, editorOrigin: handoff.origin, atlasOrigin: atlas.origin });
}
