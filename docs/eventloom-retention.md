# EventLoom retention and archival

The `.eventloom/*.jsonl` files are Zaxy-owned hash-chained authority logs. Limina tools and shell
maintenance jobs must never truncate, rewrite, `copytruncate`, compress in place, or rotate an
active session file. Doing so can break the chain, invalidate projections, and race a writer.

## Active-session policy

- The session named by `AGENTS.md` remains the only writable log for that session.
- Run `node tools/eventloom/retention-audit.mjs` in host gates. The audit is read-only and fails
  when a session log reaches 64 MiB, before growth becomes an unnoticed repository-host problem.
- A threshold failure is an operational hold, not permission to delete data. Pause agent writers,
  verify the log with `zaxy replay`, and decide the successor session with the user.
- `zaxy compact --audit <log>` is read-only. `zaxy compact --projection-output <path> <log>` may
  create a derived projection elsewhere, but it is not a replacement for the source authority.

## Archival procedure

Archival requires a stopped session and explicit human coordination because `AGENTS.md` pins the
session id used by every agent.

1. Stop all Zaxy clients/writers for the session and confirm the final `session.ended` event.
2. Run `zaxy replay .eventloom/<session>.jsonl` and retain the successful integrity report.
3. Build and verify a signed Zaxy export bundle, or make a byte-for-byte private archive plus a
   SHA-256 manifest when signing has not been configured.
4. Store the archive outside the repository with private permissions. Never put credentials or
   provider payloads into a public artifact.
5. With user approval, select a new session id, update the Zaxy activation instructions, activate
   the successor, and verify its fresh chain before resuming work.
6. Keep the old source log read-only until the archive and successor checkout have both been
   verified. Deletion is a separate retention decision and is never performed by this procedure.

The audit deliberately offers no `--fix` mode. Rotation changes memory authority and therefore
requires the same explicit coordination as any other session-boundary migration.
