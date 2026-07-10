import { consumeAtlasEditorHandoff } from "./atlas-handoff.js";

// Bootstrap owns the single destructive read. Consumers share this immutable snapshot without
// making the storage API replayable.
export const atlasEditorHandoff = consumeAtlasEditorHandoff();
