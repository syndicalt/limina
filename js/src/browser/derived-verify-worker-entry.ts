import { installDerivedVerifyWorker } from "./derived-runtime-verify.ts";

declare const WorkerGlobalScope: (new () => unknown) | undefined;

if (
  typeof WorkerGlobalScope !== "undefined"
  && typeof self !== "undefined"
  && (self as unknown) instanceof (WorkerGlobalScope as unknown as new () => unknown)
) {
  installDerivedVerifyWorker(self as unknown as Parameters<typeof installDerivedVerifyWorker>[0]);
}
