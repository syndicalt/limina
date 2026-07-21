const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;

type ReplayCommand =
  | { kind: "physics"; op: unknown; args: unknown[] }
  | { kind: "skill"; tool: string; input: unknown };

/** Return the one canonical project id in a command batch, rejecting mixed authority. */
export function authoringProjectIdForCommands(commands: readonly ReplayCommand[]): string | undefined {
  let projectId: string | undefined;
  for (const command of commands) {
    if (command.kind !== "skill" || command.tool !== "authoring.commit") continue;
    const transaction = (command.input as { transaction?: { projectId?: unknown } } | null)?.transaction;
    const candidate = transaction?.projectId;
    if (typeof candidate !== "string" || candidate.length > 64 || !PROJECT_ID.test(candidate)) {
      throw new Error("authoring.commit replay contains an invalid projectId");
    }
    if (projectId !== undefined && candidate !== projectId) {
      throw new Error(`authoring.commit replay mixes projects '${projectId}' and '${candidate}'`);
    }
    projectId = candidate;
  }
  return projectId;
}

/** Persist one runtime project binding and lazily register it on the first authoring batch. */
export class AuthoringProjectBinding {
  #projectId: string | undefined;
  #registered = false;
  readonly #register: (projectId: string) => void;

  constructor(register: (projectId: string) => void, initialProjectId?: string) {
    this.#register = register;
    if (initialProjectId !== undefined) this.#bind(initialProjectId);
  }

  ensure(commands: readonly ReplayCommand[]): string | undefined {
    const candidate = authoringProjectIdForCommands(commands);
    if (candidate === undefined) return this.#projectId;
    if (this.#projectId !== undefined && this.#projectId !== candidate) {
      throw new Error(`authoring.commit replay mixes projects '${this.#projectId}' and '${candidate}'`);
    }
    if (!this.#registered) this.#bind(candidate);
    return this.#projectId;
  }

  get projectId(): string | undefined {
    return this.#projectId;
  }

  #bind(projectId: string): void {
    authoringProjectIdForCommands([{
      kind: "skill",
      tool: "authoring.commit",
      input: { transaction: { projectId } },
    }]);
    this.#register(projectId);
    this.#projectId = projectId;
    this.#registered = true;
  }
}
