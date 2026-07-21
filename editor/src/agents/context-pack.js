// Agent context pack (fluid agents, surface-awareness): the structured bundle
// an agent receives with a turn — WHERE the human is working (workspace, tool
// and its options, selection, open doc), WHAT the world looks like right now
// (summaries, not dumps), and WHAT just happened (the ambient event window).
//
// Sources are dependency-injected so the pack is pure and node-testable; the
// app wires the real adapters (studio shell, atlas controller, docs panel,
// selection store, MCP summaries, studio event bus).
//
// Budget discipline: this rides every chat turn — summaries are small and
// capped; never put rasters, full docs, or full world dumps in a pack.

const DEFAULT_LIMITS = Object.freeze({
  recentEvents: 8,
  selection: 8,
  docsListed: 24,
  title: 60,
});

function clip(value, max) {
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function createContextPacker({ shell, atlas, docs, selection, world, events, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (events === null || typeof events !== "object" || typeof events.recent !== "function") {
    throw new TypeError("context packer requires a studio event bus");
  }

  return Object.freeze({
    pack() {
      const out = { surface: {}, world: {}, design: {}, recentEvents: events.recent(L.recentEvents) };

      // Where the human is working right now.
      if (typeof shell?.activeWorkspace === "function") out.surface.workspace = shell.activeWorkspace();
      if (typeof selection?.activeTool === "function") {
        const tool = selection.activeTool();
        if (tool !== undefined) out.surface.tool = { id: tool.id, title: tool.title };
      }
      if (typeof selection?.options === "function") {
        const opts = selection.options();
        if (opts !== undefined && Object.keys(opts).length > 0) out.surface.options = opts;
      }
      if (typeof selection?.entities === "function") {
        const picked = selection.entities().slice(0, L.selection);
        if (picked.length > 0) out.surface.selection = picked;
      }

      // World summary (small counts + what's selected, never a dump).
      if (typeof world?.summary === "function") {
        out.world = { ...out.world, ...world.summary() };
      }

      // Design surface state.
      if (typeof atlas?.summary === "function") {
        out.design.atlas = atlas.summary();
      }
      if (typeof docs?.active === "function") {
        const active = docs.active();
        if (active !== undefined) out.design.activeDoc = { name: active.name, kind: active.kind, title: clip(active.title ?? active.name, L.title) };
      }
      if (typeof docs?.list === "function") {
        const names = docs.list().slice(0, L.docsListed);
        if (names.length > 0) out.design.docs = names;
      }
      return out;
    },

    /** The pack as a compact, prompt-ready text block (one section per area). */
    packAsPromptBlock() {
      const p = this.pack();
      const lines = ["CURRENT STUDIO STATE:"];
      if (p.surface.workspace !== undefined) lines.push(`- workspace: ${p.surface.workspace}`);
      if (p.surface.tool !== undefined) lines.push(`- active tool: ${p.surface.tool.id}${p.surface.options !== undefined ? ` (${Object.entries(p.surface.options).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`);
      if (p.surface.selection !== undefined) lines.push(`- selection: ${p.surface.selection.join(", ")}`);
      if (p.design.atlas !== undefined) lines.push(`- atlas: ${p.design.atlas}`);
      if (p.design.activeDoc !== undefined) lines.push(`- open doc: ${p.design.activeDoc.name} (${p.design.activeDoc.kind}) "${p.design.activeDoc.title}"`);
      if (p.world !== undefined && Object.keys(p.world).length > 0) lines.push(`- world: ${Object.entries(p.world).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      if (p.recentEvents.length > 0) {
        lines.push("- recent activity:");
        for (const e of p.recentEvents) lines.push(`  · ${e.type}${e.detail !== undefined ? ` — ${clip(e.detail, L.title)}` : ""}`);
      }
      return lines.join("\n");
    },
  });
}
