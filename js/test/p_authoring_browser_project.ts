import { AuthoringProjectBinding, authoringProjectIdForCommands } from "../src/browser/authoring-project.ts";
import type { AuthorCommand } from "../src/browser/sim-worker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_browser_project: ${message}`);
}

function commit(projectId: string, transactionId: string): AuthorCommand {
  return {
    kind: "skill",
    tool: "authoring.commit",
    input: { transaction: { projectId, transactionId } },
  };
}

const registrations: string[] = [];
const binding = new AuthoringProjectBinding((projectId) => { registrations.push(projectId); });
binding.ensure([{ kind: "skill", tool: "scene.createEntity", input: { shape: "box" } }]);
assert(registrations.length === 0 && binding.projectId === undefined, "legacy-only boot registered fake authority");

binding.ensure([commit("grey-field", "tx.first")]);
assert(registrations.length === 1 && registrations[0] === "grey-field", "first incremental commit did not register its project");
binding.ensure([commit("grey-field", "tx.undo")]);
assert(registrations.length === 1, "same-project compensation registered a second runtime");

let mixed = false;
try { binding.ensure([commit("other-project", "tx.foreign")]); } catch (error) {
  mixed = error instanceof Error && error.message.includes("mixes projects");
}
assert(mixed, "a later foreign project did not fail closed");

let malformed = false;
try { authoringProjectIdForCommands([commit("Grey:Field", "tx.bad")]); } catch (error) {
  malformed = error instanceof Error && error.message.includes("invalid projectId");
}
assert(malformed, "non-canonical projectId was accepted");

let mixedBatch = false;
try { authoringProjectIdForCommands([commit("grey-field", "tx.a"), commit("other-project", "tx.b")]); } catch (error) {
  mixedBatch = error instanceof Error && error.message.includes("mixes projects");
}
assert(mixedBatch, "mixed projects in one batch were accepted");

console.log("p_authoring_browser_project OK: legacy boot, lazy first commit, stable binding, and mixed-project rejection");
