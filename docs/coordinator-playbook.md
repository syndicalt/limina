# Limina Coordinator Playbook

You are already an agent (Codex, Claude Code, OpenCode, Hermes, …). This is how you
coordinate a **limina** build: you are the **coordinator**, limina is the substrate,
and you spawn **builder subagents** to author the world — exactly like a lead farming
tasks to a team and reviewing their work.

Limina never runs the brain. It provides the **world**, its **skills as MCP tools**,
the **plan/GDS**, and the **gates**. You provide the reasoning and the builders (your
own subagents, on your own auth).

## 1. Connect to the live world

A running `editor_host` holds the world the browser viewport renders. Author into it
through the **editor bridge** (a stdio MCP server) so everything you and your builders
do shows up live:

- Register the bridge as an MCP server: `node tools/bridge/limina-bridge.mjs`, with
  `LIMINA_EDITOR_TOKEN` (printed when `editor_host` boots) in its env.
- Each **builder subagent runs its OWN bridge instance** with a distinct
  `LIMINA_AGENT_ID` — the recorder tracks each as an independent chain, so concurrent
  builders never corrupt the one world log.

The skills you get are the authoring surface: `scene.createEntity`, terrain, asset,
lighting, material, `ecs.updateComponent`, plus `skills.search` / `skills.describe`
for discovering the rest. You start with a small core set and load more on demand.

## 2. The loop

1. **Read the intent.** Load the project's GDS / architecture plan. If none exists,
   interview the human (or read their GDD) into a GDS first.
2. **Decompose into slices**, ordered by dependency, not by domain. Terrain before the
   buildings that sit on it; props/foliage after both. Slice 0 is always the smallest
   playable/visible thing.
3. **Assign each slice to a builder subagent.** Hand it a self-contained packet:
   - the **slice goal** in plain terms,
   - the **live scene state it needs** — tell it to READ the world via skills
     (`scene.queryEntities`, `scene.inspect`) rather than assume; the world log is the
     shared memory,
   - **scoped tool guidance**: "use `skills.search`/`skills.describe` to find + learn a
     skill before calling it; don't guess arguments."
   Builders are **generalists** — the *task* is specialized, not the builder. The same
   worker does terrain now and props later.
4. **Builder authors** via its bridge (its skill calls appear live in the viewport,
   under its own agent-cue).
5. **Review + gate.** Check the builder's result against the slice's definition of done
   (run the functional gate if the plan defines one). **Halt on red** — nothing
   downstream proceeds until it passes.
6. **Integrate and continue** to the next slice.

## 3. Principles

- **World log = shared memory.** Builders and you read current scene state through
  skills; no private per-builder context, no assumptions about what's there.
- **Scope discipline.** A builder does exactly its slice and stops — no "fleshing out"
  the scene, no extras the human didn't ask for. Leftover budget is not a mandate.
- **Concurrency is safe** when slices are independent (or worktree-isolated). Prefer
  clean slice boundaries; the recorder handles interleaved chains.
- **You are the single seam to the human.** The human talks only to you (the
  coordinator); you dispatch to builders and relay their questions/results back. Don't
  make the human route messages to individual builders.
- **Roles are your scheduling concept**, not builder identities — you may keep one
  worker on terrain for a phase for coherence, then reassign.

## 4. Standalone mode (no external agent)

If someone has no coding-agent session, `editor_host` can run a built-in build agent
directly from the chat window (`ANTHROPIC_API_KEY` in the project `.env`). That is the
fallback single-agent path; the primary path is this playbook — you, coordinating a
team, on your own auth.
