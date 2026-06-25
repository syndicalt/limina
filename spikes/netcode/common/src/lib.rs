//! On-wire message contract for the P4.0c netcode spike.
//!
//! Newline-delimited JSON over a raw localhost TCP socket -- the same line-framed
//! JSON discipline the engine's MCP transport uses (`js/src/mcp/mcp.ts`), minus
//! the JSON-RPC envelope. The point of the spike is the NETCODE MODEL, not the
//! framing: an authoritative server, intents in, authoritative state deltas out.
//!
//! Authority is encoded in the message set itself:
//!   * `Intent` is the ONLY message that can change authoritative state, and only
//!     after the server permission-checks it against the client's grant set and
//!     applies it on a fixed-step tick boundary.
//!   * `StateWrite` is a client trying to set authoritative state DIRECTLY. The
//!     server has no code path that applies it -- it is always rejected. That is
//!     the authority demonstration (Global anti-hack: "a client's direct state
//!     write is rejected").

use serde::{Deserialize, Serialize};

/// A single entity's authoritative state (position + velocity). Doubles as the
/// snapshot/delta payload element.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct EntityState {
    pub id: u32,
    pub pos: [f64; 3],
    pub vel: [f64; 3],
}

/// Client -> Server. `type` discriminates (internally tagged, snake_case).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Join the world; server replies `Welcome` with the current snapshot + the
    /// capabilities this client is granted.
    Hello { client: String },
    /// Pure transport round-trip probe (no sim involvement) -- isolates socket
    /// cost from the fixed-step quantization in the latency report.
    Ping { id: u64 },
    /// Read the full authoritative snapshot. A READ: clients are views.
    Snapshot { id: u64 },
    /// INTENT: a tool/skill call. The only authoritative mutation path. The
    /// server permission-checks `skill` against the client's grants, then applies
    /// it on the next tick and broadcasts the resulting delta (tagged `caused_by`).
    Intent {
        id: u64,
        skill: String,
        entity: u32,
        arg: [f64; 3],
    },
    /// UNAUTHORIZED DIRECT STATE WRITE. A client trying to bypass the intent path
    /// and set authoritative state itself. The server always rejects this.
    StateWrite { id: u64, entity: u32, pos: [f64; 3] },
}

/// Server -> Client. `type` discriminates (internally tagged, snake_case).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Join ack: current tick, the snapshot (client is a view of authoritative
    /// state), and the capability grant set the server will enforce.
    Welcome {
        tick: u64,
        grants: Vec<String>,
        entities: Vec<EntityState>,
    },
    /// Pong for a `Ping`.
    Pong { id: u64 },
    /// Full snapshot reply for a `Snapshot` read.
    SnapshotResult {
        id: u64,
        tick: u64,
        entities: Vec<EntityState>,
    },
    /// Authoritative state delta, broadcast after a tick. `caused_by` lists the
    /// intent ids applied on this tick so a client can match its own intent to
    /// the tick it landed on (intent -> applied -> synced). `changes` carries only
    /// the entities that changed this tick (the O(relevant) shape M5 builds on).
    Delta {
        tick: u64,
        caused_by: Vec<u64>,
        changes: Vec<EntityState>,
    },
    /// A rejected message: permission denial, unknown entity, or -- the authority
    /// case -- a direct state write. `reason` is human-readable.
    Reject { id: u64, reason: String },
}
