// Emit the Beacon Run GDS as one JSON line so the host-side design gate (node, gates/design/gds-gate.mjs)
// can score the REAL game spec — not a hand-fed asset list. Run through the limina binary:
//   ./target/release/limina games/beacon-quest/emit-gds.ts   ->  prints  __GDS_JSON__{...}
import { BEACON_RUN } from "../../js/src/game/examples/beacon_run.gds.ts";
import { ops } from "../../js/src/engine.ts";

ops.op_log("__GDS_JSON__" + JSON.stringify(BEACON_RUN));
