// Default stdio MCP server entry for `limina --mcp-stdio`.
//
// Requests are newline-delimited JSON-RPC 2.0 on stdin. Responses are newline-
// delimited JSON-RPC 2.0 on stdout. The process exits cleanly on stdin EOF.

import { EntityTable, ops } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { Mcp, StdioMcpTransport } from "./mcp.ts";

declare const Deno: { core: { ops: typeof ops & {
  op_mcp_read_stdin_line(): Promise<string>;
  op_mcp_write_stdout_line(line: string): void;
} } };

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

ops.op_physics_create_world(0);

const registry = new SkillRegistry(new LiminaTracer("mcp_stdio"));
registerCoreSkills(registry);

const transport = new StdioMcpTransport(
  new Mcp(registry, world),
  (line) => Deno.core.ops.op_mcp_write_stdout_line(line),
);

while (true) {
  const line = await Deno.core.ops.op_mcp_read_stdin_line();
  if (line.length === 0) break;
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  await transport.handleLine(trimmed);
}
