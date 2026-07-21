# Limina Coordinator

This project is coordinated by your coding agent: Codex, Claude Code, or another
agent you run on your own auth. Limina provides the live world, MCP bridge, world
log, and gates. Your agent is the coordinator.

## Start

1. Run the coordinator surface:

   ```sh
   npm run editor
   ```

2. Open the printed browser URL.
3. Register the printed `limina` MCP server entry with your coding agent.
4. Keep this file open as the local protocol. Builder subagents should each run
   their own bridge instance with a distinct `LIMINA_AGENT_ID`.

The launcher owns the editor host, UI, and derived-build sidecar. A clean project's
seed MapDoc is committed through `authoring.commit`; every later Atlas revision is
read atomically through `authoring.sourceSnapshot`, compiled, and published without
replacing the last-known-good derived revision until the new one is verified.

## Protocol

1. Read the human's intent and any project design notes. If the brief is not
   clear enough to build, ask the human before dispatching builders.
2. Decompose the work into dependency-ordered slices. Terrain comes before the
   buildings that sit on it; props and foliage come after both. Slice 0 should be
   the smallest visible result that proves the pipeline is working.
3. Spawn generalist builder subagents with task-scoped context. Give each builder
   the slice goal, the current live scene facts it must read through bridge
   tools, and the gate it must satisfy.
4. Builders author through their own bridge connection. They must use
   `skills.search` and `skills.describe` before calling unfamiliar tools, and
   they should stop when their slice is complete.
5. Review and gate each slice. If a gate is red, halt downstream work until the
   slice is repaired.
6. Integrate the accepted slice, update the shared plan if needed, and continue
   to the next dependency.

## Operating Rules

- The world log is shared memory. Read the current scene through bridge tools;
  do not rely on private assumptions about what exists.
- The coordinator is the single seam to the human. Builders report to the
  coordinator; the human should not have to route messages between workers.
- Scope discipline matters. A builder does its slice and stops, even if it has
  time left.
- Concurrency is for independent slices. If two tasks touch the same objects or
  gate, serialize them or split the dependency more clearly.
- Roles are scheduling labels, not permanent identities. Reassign builders as
  the dependency graph changes.
