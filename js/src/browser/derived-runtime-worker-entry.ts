import { installDerivedRuntimeWorker } from "./derived-runtime-worker.ts";

declare const WorkerGlobalScope: (new () => unknown) | undefined;

if (
  typeof WorkerGlobalScope !== "undefined"
  && typeof self !== "undefined"
  && (self as unknown) instanceof (WorkerGlobalScope as unknown as new () => unknown)
) {
  installDerivedRuntimeWorker(self as unknown as Parameters<typeof installDerivedRuntimeWorker>[0]);
}
