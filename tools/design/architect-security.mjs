const EDITOR_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export function requireArchitectEditorToken(environment, caller) {
  const token = environment?.LIMINA_EDITOR_TOKEN;
  if (typeof token !== "string" || !EDITOR_TOKEN.test(token)) {
    throw new Error(`${caller}: LIMINA_EDITOR_TOKEN must be an explicit 32-128 character URL-safe capability`);
  }
  return token;
}
