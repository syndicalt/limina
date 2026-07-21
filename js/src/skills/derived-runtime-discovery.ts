import { z } from "../../build/zod.bundle.mjs";
import { DERIVED_RUNTIME_DISCOVERY_PERMISSION } from "./permissions.ts";
import { SkillInvocationError, type SkillDefinition, type SkillRegistry } from "./registry.ts";

export const DERIVED_RUNTIME_DISCOVERY_SCHEMA = "limina.derived-runtime-access/v1";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
// 32 bytes encode as 43 unpadded base64url characters. The final alphabet index
// must have its low two padding bits clear for the encoding to be canonical.
const DERIVED_RUNTIME_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface DerivedRuntimeDiscovery {
  readonly schema: typeof DERIVED_RUNTIME_DISCOVERY_SCHEMA;
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly branchId: string;
}

export function derivedRuntimeDiscovery(input: {
  baseUrl: string;
  token: string;
  projectId: string;
  branchId: string;
}): DerivedRuntimeDiscovery {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join() !== "baseUrl,branchId,projectId,token") {
    throw new Error("derived runtime discovery config must contain exactly baseUrl, token, projectId, and branchId");
  }
  for (const key of ["baseUrl", "token", "projectId", "branchId"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
        || typeof descriptor.value !== "string") {
      throw new Error("derived runtime discovery config fields must be enumerable string data properties");
    }
  }
  let url: URL;
  try { url = new URL(input.baseUrl); }
  catch (error) { throw new Error("derived runtime discovery baseUrl must be a canonical loopback HTTP origin", { cause: error }); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === ""
      || url.origin !== input.baseUrl || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.username !== "" || url.password !== "") {
    throw new Error("derived runtime discovery baseUrl must be a canonical 127.0.0.1 HTTP origin with an explicit port");
  }
  if (!DERIVED_RUNTIME_TOKEN.test(input.token)) {
    throw new Error("derived runtime discovery token must canonically encode exactly 32 bytes");
  }
  if (!PROJECT_ID.test(input.projectId)) throw new Error("derived runtime discovery projectId is invalid");
  if (!BRANCH_ID.test(input.branchId)) throw new Error("derived runtime discovery branchId is invalid");
  return Object.freeze({
    schema: DERIVED_RUNTIME_DISCOVERY_SCHEMA,
    baseUrl: input.baseUrl,
    token: input.token,
    projectId: input.projectId,
    branchId: input.branchId,
  });
}

export function registerDerivedRuntimeDiscoverySkill(
  registry: SkillRegistry,
  discovery: DerivedRuntimeDiscovery,
): void {
  if (discovery.schema !== DERIVED_RUNTIME_DISCOVERY_SCHEMA) throw new Error("runtime.derivedDiscovery schema is invalid");
  const validated = derivedRuntimeDiscovery({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    projectId: discovery.projectId,
    branchId: discovery.branchId,
  });
  const skill: SkillDefinition<Record<string, never>, DerivedRuntimeDiscovery> = {
    name: "runtime.derivedDiscovery",
    version: "1.0.0",
    description: "Return the authenticated editor session's loopback derived-runtime access capability.",
    category: "system",
    permissions: [DERIVED_RUNTIME_DISCOVERY_PERMISSION],
    effect: "read",
    priority: "advanced",
    input: z.object({}).strict(),
    output: z.object({
      schema: z.literal(DERIVED_RUNTIME_DISCOVERY_SCHEMA),
      baseUrl: z.string(),
      token: z.string(),
      projectId: z.string(),
      branchId: z.string(),
    }).strict(),
    handler: (_input, ctx) => {
      if (ctx.profile !== "reviewer" && ctx.profile !== "system.readonly") {
        throw new SkillInvocationError("forbidden", "runtime.derivedDiscovery is restricted to reviewer and system.readonly sessions");
      }
      return validated;
    },
  };
  registry.register(skill);
}
