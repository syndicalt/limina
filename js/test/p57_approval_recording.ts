// P57 -- approval-granted actions must enter the AUTHORING worldlog as the original
// skill command, while approval.* control skills stay out of the authoring stream.
//
// Run: limina js/test/p57_approval_recording.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { registerWorldlogSkills, worldCommandsToAuthor } from "../src/skills/worldlog.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";
import type { AuthorCommand } from "../src/kernel/authoring.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p57_approval_recording FAIL: " + message);
}

function skillTools(commands: readonly WorldCommand[]): string[] {
  return commands.filter((c) => c.kind === "skill").map((c) => (c as { tool: string }).tool);
}

async function proposeAndGrant(session: string): Promise<{
  before: number;
  after: number;
  tail: { commands: WorldCommand[]; next: number; reset: boolean };
  authored: AuthorCommand[];
  grantedCommand: WorldCommand;
}> {
  const ctx = createHeadlessContext({ session, record: {} });
  const { registry, world, recorder } = ctx;
  assert(recorder !== undefined, "test context did not create a recorder");
  registerWorldlogSkills(registry, { recorder });
  registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));

  const proposingAgent = "agt_builder_review";
  const reviewer = "human_reviewer";
  const builderBase = (tick: number) => ({
    agentId: proposingAgent,
    sessionId: session,
    permissions: resolveProfile("builder.review"),
    profile: "builder.review",
    tick,
    world,
  });
  const reviewerBase = (tick: number) => ({
    agentId: reviewer,
    sessionId: session,
    permissions: resolveProfile("reviewer"),
    profile: "reviewer",
    tick,
    world,
  });

  ctx.setTick(0);
  ctx.ops.op_physics_create_world(0);
  const before = world.entities.ids().length;

  ctx.setTick(1);
  const held = await registry.invoke(
    "scene.createEntity",
    { shape: "box", position: [2, 3, 4], dynamic: true },
    builderBase(1),
  );
  assert(!held.success && held.error?.code === "pending_approval", "scene.createEntity was not held");
  const approvalId = held.error.message;
  assert(world.entities.ids().length === before, "held action changed the world before grant");

  ctx.setTick(2);
  const grant = await registry.invoke("approval.grant", { approvalId }, reviewerBase(2));
  assert(grant.success && (grant.result as { applied?: boolean }).applied === true, "approval.grant did not apply");
  const after = world.entities.ids().length;
  assert(after === before + 1, `granted action did not create exactly one entity (${before}->${after})`);

  const tail = (await registry.invoke("worldlog.tail", { since: 0 }, reviewerBase(3))).result as {
    commands: WorldCommand[];
    next: number;
    reset: boolean;
  };
  const authored = worldCommandsToAuthor(tail.commands);
  const grantedCommand = tail.commands.find((c) => c.kind === "skill" && (c as { tool: string }).tool === "scene.createEntity");
  assert(grantedCommand !== undefined, "worldlog.tail did not return the granted scene.createEntity command");

  return { before, after, tail, authored, grantedCommand };
}

const first = await proposeAndGrant("ses_p57");
const tools = skillTools(first.tail.commands);

assert(tools.includes("scene.createEntity"), "authoring tail must include granted scene.createEntity");
assert(!tools.includes("approval.grant"), "authoring tail must not include approval.grant");
assert(!tools.includes("approval.deny"), "authoring tail must not include approval.deny");
assert(!tools.includes("approval.list"), "authoring tail must not include approval.list");

const createAuthor = first.authored.find((c) => c.kind === "skill" && (c as { tool: string }).tool === "scene.createEntity") as
  | ({ kind: "skill"; tool: string; agentId?: string })
  | undefined;
assert(createAuthor !== undefined, "worldCommandsToAuthor did not translate granted scene.createEntity");
assert(createAuthor.agentId === "agt_builder_review", `granted command actor must be proposer, got ${createAuthor.agentId}`);

assert(!first.tail.commands.some((c) => c.kind === "physics" && /add_(box|sphere|capsule)/.test((c as { op: string }).op)),
  "granted skill's internal physics op leaked as a standalone physics command");
assert(first.after === first.before + 1, "world does not contain the granted entity");

const second = await proposeAndGrant("ses_p57");
assert(
  JSON.stringify(first.grantedCommand) === JSON.stringify(second.grantedCommand),
  "recorded granted scene.createEntity command is not byte-identical across identical propose+grant runs",
);

ops.op_log("p57_approval_recording OK: granted approvals record the original authoring skill once; approval controls and internal physics ops stay out of the viewport stream");
