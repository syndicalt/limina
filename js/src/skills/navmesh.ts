// navmesh.* skills — pathfinding and navigation.
// All inputs accept optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface NavmeshEdge {
  from: number;
  to: number;
  cost: number;
}

export interface NavmeshData {
  vertices: Float32Array;
  edges: NavmeshEdge[];
  regions: number[];
  built: boolean;
}

export interface NavigationAgent {
  entity: string;
  path: [number, number, number][];
  pathIndex: number;
  speed: number;
  active: boolean;
}

export class NavmeshManager {
  private navmesh: NavmeshData | null = null;
  private readonly agents = new Map<string, NavigationAgent>();

  build(): boolean {
    // Placeholder: In a full implementation, this would scan terrain/physics
    // geometry and generate a navmesh. For now, agents define navmesh data manually.
    this.navmesh = { vertices: new Float32Array(0), edges: [], regions: [], built: true };
    return true;
  }

  isBuilt(): boolean {
    return this.navmesh?.built ?? false;
  }

  findPath(from: [number, number, number], to: [number, number, number]): [number, number, number][] {
    // Simple direct path — A* would use navmesh data
    return [from, to];
  }

  isReachable(from: [number, number, number], to: [number, number, number]): boolean {
    if (!this.isBuilt()) return false;
    return true;
  }

  moveTo(entity: string, target: [number, number, number], speed?: number): void {
    const agent = this.agents.get(entity);
    if (agent !== undefined) {
      agent.path = agent.path.length > 0 ? agent.path : [[0, 0, 0], target];
      agent.pathIndex = 0;
      agent.speed = speed ?? agent.speed;
      agent.active = true;
    } else {
      this.agents.set(entity, { entity, path: [[0, 0, 0], target], pathIndex: 0, speed: speed ?? 3, active: true });
    }
  }

  setSpeed(entity: string, speed: number): boolean {
    const agent = this.agents.get(entity);
    if (agent === undefined) return false;
    agent.speed = speed;
    return true;
  }

  step(dtMs: number): Map<string, { entity: string; position: [number, number, number]; arrived: boolean }> {
    const results = new Map<string, { entity: string; position: [number, number, number]; arrived: boolean }>();
    for (const [entity, agent] of this.agents) {
      if (!agent.active || agent.path.length === 0) continue;
      if (agent.pathIndex >= agent.path.length - 1) {
        results.set(entity, { entity, position: agent.path[agent.path.length - 1], arrived: true });
        agent.active = false;
        continue;
      }
      const target = agent.path[agent.pathIndex + 1];
      const current = agent.path[agent.pathIndex];
      const dx = target[0] - current[0];
      const dy = target[1] - current[1];
      const dz = target[2] - current[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const move = agent.speed * (dtMs / 1000);
      if (move >= dist) {
        agent.pathIndex++;
        results.set(entity, { entity, position: target, arrived: agent.pathIndex >= agent.path.length - 1 });
      } else {
        const t = move / dist;
        agent.path[agent.pathIndex] = [
          current[0] + dx * t,
          current[1] + dy * t,
          current[2] + dz * t,
        ];
        results.set(entity, { entity, position: agent.path[agent.pathIndex], arrived: false });
      }
    }
    return results;
  }
}

const buildNavmeshInput = z.object({
  config: z.record(z.string(), z.unknown()).optional().describe("Custom navmesh generation config (cell size, agent height/radius, etc.)."),
  meta: MetaField,
});

const buildNavmesh: SkillDefinition<z.infer<typeof buildNavmeshInput>, { ok: boolean }> = {
  name: "navmesh.build",
  version: "1.0.0",
  description: "Build a navmesh for the current world geometry. Uses terrain, colliders, and walkable surfaces.",
  category: "nav",
  permissions: ["nav.configure"],
  input: buildNavmeshInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { navmeshManager?: NavmeshManager }).navmeshManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.build();
    ctx.emit("navmesh.built", { ok, ...input.meta });
    return { ok };
  },
};

const findPathInput = z.object({
  from: Vec3.describe("Start position."),
  to: Vec3.describe("Target position."),
  meta: MetaField,
});

const findPath: SkillDefinition<z.infer<typeof findPathInput>, { path: [number, number, number][]; reachable: boolean }> = {
  name: "navmesh.findPath",
  version: "1.0.0",
  description: "Find a path between two positions. Returns a list of waypoints.",
  category: "nav",
  permissions: ["nav.read"],
  input: findPathInput,
  output: z.object({ path: z.array(Vec3), reachable: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { navmeshManager?: NavmeshManager }).navmeshManager;
    if (mgr === undefined) return { path: [], reachable: false };
    const path = mgr.findPath(input.from, input.to);
    return { path, reachable: path.length > 0 };
  },
};

const moveToInput = z.object({
  entity: z.string(),
  target: Vec3.describe("Target position to navigate to."),
  speed: z.number().positive().optional().describe("Movement speed (world units/second)."),
  meta: MetaField,
});

const moveTo: SkillDefinition<z.infer<typeof moveToInput>, { ok: boolean }> = {
  name: "navmesh.moveTo",
  version: "1.0.0",
  description: "Move an entity along a path toward a target position using the navmesh.",
  category: "nav",
  permissions: ["nav.write"],
  input: moveToInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { navmeshManager?: NavmeshManager }).navmeshManager;
    if (mgr === undefined) return { ok: false };
    mgr.moveTo(input.entity, input.target, input.speed);
    ctx.emit("navmesh.moveTo", { entity: input.entity, target: input.target, speed: input.speed, ...input.meta });
    return { ok: true };
  },
};

const setNavSpeedInput = z.object({
  entity: z.string(),
  speed: z.number().positive(),
  meta: MetaField,
});

const setNavSpeed: SkillDefinition<z.infer<typeof setNavSpeedInput>, { ok: boolean }> = {
  name: "navmesh.setSpeed",
  version: "1.0.0",
  description: "Set an entity's movement speed while navigating.",
  category: "nav",
  permissions: ["nav.write"],
  input: setNavSpeedInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { navmeshManager?: NavmeshManager }).navmeshManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.setSpeed(input.entity, input.speed);
    ctx.emit("navmesh.speedSet", { entity: input.entity, speed: input.speed, ok, ...input.meta });
    return { ok };
  },
};

const isReachableInput = z.object({
  entity: z.string().optional().describe("Entity to check from. If omitted, uses from position."),
  from: Vec3.optional(),
  to: Vec3,
  meta: MetaField,
});

const isReachable: SkillDefinition<z.infer<typeof isReachableInput>, { reachable: boolean }> = {
  name: "navmesh.isReachable",
  version: "1.0.0",
  description: "Check if a position is reachable from an entity's current position (or a specified from position).",
  category: "nav",
  permissions: ["nav.read"],
  input: isReachableInput,
  output: z.object({ reachable: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { navmeshManager?: NavmeshManager }).navmeshManager;
    if (mgr === undefined) return { reachable: false };
    const from = input.from ?? [0, 0, 0];
    const reachable = mgr.isReachable(from, input.to);
    return { reachable };
  },
};

export function registerNavmeshSkills(registry: SkillRegistry, opts?: { navmeshManager?: NavmeshManager }): { navmeshManager: NavmeshManager } {
  const mgr = opts?.navmeshManager ?? new NavmeshManager();

  registry.register(buildNavmesh);
  registry.register(findPath);
  registry.register(moveTo);
  registry.register(setNavSpeed);
  registry.register(isReachable);

  return { navmeshManager: mgr };
}
