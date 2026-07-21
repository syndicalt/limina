// Studio shell (studio-unification U1): the single panel manifest for the unified
// surface. Existing editor chrome (accordions, viewport, inspector, console, chat)
// and the new design panels register in ONE panel-registry with two layout
// profiles: "studio" (everything) and "design" (the docs/maps-only usage that used
// to be the standalone Design Space app). Visibility applies by toggling the
// `hidden` property on the manifest's element ids — orthogonal to the accordions'
// own open/close, so no existing behavior is repurposed.
//
// Design panels without an elementId mount lazily (their panel module creates its
// own root inside a host section); they still register here so profiles and
// visibility cover them uniformly.

import { createPanelRegistry } from "./panel-registry.js";

export const STUDIO_PANELS = Object.freeze([
  { id: "world", title: "World", elementId: "world", membership: ["studio"], defaultVisible: true },
  { id: "content-browser", title: "Content Browser", elementId: "content-browser", membership: ["studio"], defaultVisible: true },
  { id: "history", title: "History", elementId: "history", membership: ["studio"], defaultVisible: true },
  { id: "activity", title: "Activity", elementId: "reasoning", membership: ["studio"], defaultVisible: true },
  { id: "team", title: "Team", elementId: "roster", membership: ["studio", "design"], defaultVisible: true },
  { id: "approval", title: "Approval", elementId: "approval", membership: ["studio"], defaultVisible: true },
  { id: "viewport", title: "Viewport", elementId: "viewport", membership: ["studio"], defaultVisible: true },
  { id: "inspector", title: "Inspector", elementId: "inspector", membership: ["studio"], defaultVisible: true },
  { id: "console", title: "Console", elementId: "console-panel", membership: ["studio"], defaultVisible: true },
  { id: "chat", title: "Chat", elementId: "chat", membership: ["studio", "design"], defaultVisible: true },
  { id: "docs", title: "Design Docs", membership: ["studio", "design"], defaultVisible: true },
  // 2.0-D design panels: no elementId — the design workspace's tab strip owns
  // mounting (Docs | Places | Graph), exactly like `docs` above.
  { id: "places", title: "Design Places", membership: ["studio", "design"], defaultVisible: true },
  { id: "graph", title: "Design Graph", membership: ["studio", "design"], defaultVisible: true },
]);

// Profile order IS the panel arrangement order (panel-registry canonical ordering).
export const STUDIO_PROFILES = Object.freeze({
  studio: Object.freeze(["docs", "places", "graph", "world", "content-browser", "history", "activity", "team", "approval", "viewport", "inspector", "console", "chat"]),
  design: Object.freeze(["docs", "places", "graph", "team", "chat"]),
});

export function createStudioShell({ storage, onChange } = {}) {
  const registry = createPanelRegistry({ storage, onChange });
  for (const panel of STUDIO_PANELS) {
    registry.register({
      id: panel.id,
      title: panel.title,
      profileMembership: panel.membership,
      defaultVisible: panel.defaultVisible,
    });
  }
  for (const [name, ids] of Object.entries(STUDIO_PROFILES)) registry.defineProfile(name, ids);

  /** Toggle `hidden` on every manifest element. Panels without an elementId are
   *  skipped (their host section owns mounting). `doc` is injectable for tests. */
  function applyVisibility(doc) {
    const d = doc ?? (typeof document !== "undefined" ? document : undefined);
    if (d === undefined) throw new Error("studio shell applyVisibility requires a document");
    const visible = new Set(registry.visibleIds());
    for (const panel of STUDIO_PANELS) {
      if (panel.elementId === undefined) continue;
      const el = d.getElementById(panel.elementId);
      if (el !== null && el !== undefined) el.hidden = !visible.has(panel.id);
    }
    return [...visible];
  }

  return Object.freeze({ registry, applyVisibility });
}
