// store.js — shared mutable app state + a late-binding registry so map.js and app.js never import
// each other (no ES-module cycles): app.js assigns its cross-cutting functions (reload, cascade,
// chat context) onto S.fn at boot, map.js calls them through S.fn.

export const S = {
  state: null,        // the /api/state payload (docs, maps, world, graph, build)
  activeDoc: null,
  activeView: "docs",
  fn: {
    reload: async () => {},        // app.js load()
    surfaceCascade: () => {},      // app.js cascade panel
    updateChatCtx: () => {},       // app.js chat context line
    chatOpen: () => false,         // whether the chat drawer has an agent
    refreshPlaces: () => {},       // app.js re-render of the Places tree (after a map place edit)
  },
};
