import { configureNativeRendererSurface, type RendererLike } from "../src/engine.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_native_surface_configuration FAIL: ${message}`);
}

function rendererWithSurface(input: {
  readonly validation?: { message?: string } | null;
  readonly contextFailure?: Error;
  readonly popFailure?: Error;
}): { renderer: RendererLike; events: string[] } {
  const events: string[] = [];
  const backend = {
    trackTimestamp: false,
    device: {
      queue: { onSubmittedWorkDone: async () => undefined },
      pushErrorScope: (filter: "validation") => events.push(`push:${filter}`),
      popErrorScope: async () => {
        events.push("pop");
        if (input.popFailure) throw input.popFailure;
        return input.validation ?? null;
      },
    },
    get context(): unknown {
      events.push("configure");
      if (input.contextFailure) throw input.contextFailure;
      return {};
    },
  };
  return {
    events,
    renderer: { backend } as unknown as RendererLike,
  };
}

const success = rendererWithSurface({ validation: null });
await configureNativeRendererSurface(success.renderer);
assert(success.events.join(",") === "push:validation,configure,pop", "surface was not configured inside one validation scope");

const rejected = rendererWithSurface({ validation: { message: "requested usage COPY_SRC is unsupported" } });
let rejectionExposed = false;
try {
  await configureNativeRendererSurface(rejected.renderer);
} catch (error) {
  rejectionExposed = error instanceof Error && /COPY_SRC is unsupported/.test(error.message);
}
assert(rejectionExposed, "asynchronous surface validation reason was hidden");

const thrown = rendererWithSurface({ contextFailure: new Error("configure threw") });
let synchronousPreserved = false;
try {
  await configureNativeRendererSurface(thrown.renderer);
} catch (error) {
  synchronousPreserved = error instanceof AggregateError && error.errors[0] instanceof Error
    && error.errors[0].message === "configure threw";
}
assert(synchronousPreserved && thrown.events.at(-1) === "pop", "synchronous failure escaped without balancing the error scope");

let unavailableRejected = false;
try {
  await configureNativeRendererSurface({ backend: { trackTimestamp: false } } as unknown as RendererLike);
} catch (error) {
  unavailableRejected = error instanceof Error && /validation scopes are unavailable/.test(error.message);
}
assert(unavailableRejected, "missing native validation scopes were accepted");

console.log("p_native_surface_configuration OK: eager configure, scoped diagnostics, and failure balancing are proven");
