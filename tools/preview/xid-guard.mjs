import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const NVIDIA_XID_GUARD_SCHEMA = "limina.nvidia-xid-guard/v1";
export const NVIDIA_XID_POLL_MS = 250;

const XID = /(?:NVRM:\s*)?Xid\b|Xid \(PCI/i;
const FOLLOWER_ARGS = Object.freeze(["-k", "-b", "-f", "-n", "0", "--no-pager", "-o", "cat"]);
const SNAPSHOT_ARGS = Object.freeze(["-k", "-b", "--no-pager", "-o", "cat"]);
const IMPLEMENTATION_PATH = "tools/preview/xid-guard.mjs";
const implementationBytes = await readFile(new URL(import.meta.url));
const IMPLEMENTATION_SHA256 = `sha256:${createHash("sha256").update(implementationBytes).digest("hex")}`;

const messageOf = (error) => error instanceof Error ? error.message : String(error);

export function firstNvidiaXid(text) {
  return String(text).split(/\r?\n/).find((line) => XID.test(line))?.trim();
}

export function readCurrentBootKernelLog() {
  return new Promise((resolve, reject) => {
    execFile("journalctl", SNAPSHOT_ARGS, { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`cannot establish required Xid guard: ${error.message ?? stderr ?? "journalctl failed"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function readCurrentBootId() {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!bootId || bootId.length > 128 || /\s/.test(bootId)) throw new Error("cannot establish required Xid guard: invalid Linux boot identity");
  return bootId;
}

function xidStop(event, phase) {
  if (phase === "preflight") return new Error(`current boot already contains an NVIDIA Xid; reboot before any native capture retry: ${event}`);
  if (phase === "postflight") return new Error(`NVIDIA Xid detected after capture; stop immediately, report ${event}, and do not retry until reboot`);
  return new Error(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${event}`);
}

function guardEvidence(bootId, pollMs) {
  return Object.freeze({
    schema: NVIDIA_XID_GUARD_SCHEMA,
    implementation: Object.freeze({ path: IMPLEMENTATION_PATH, sha256: IMPLEMENTATION_SHA256 }),
    bootId,
    preflight: Object.freeze({ source: "journalctl-kernel-current-boot", xidObserved: false }),
    live: Object.freeze({ follower: "journalctl-kernel-follow-current-boot", redundantPollMs: pollMs, xidObserved: false }),
    postflight: Object.freeze({ source: "journalctl-kernel-current-boot", xidObserved: false }),
  });
}

/**
 * One guard instance owns a process-local Xid latch. Once an Xid is observed, every later capture
 * on the same boot is rejected even if a caller supplies a faulty snapshot reader that loses it.
 */
export function createNvidiaXidGuard(dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const kernelLog = dependencies.kernelLog ?? readCurrentBootKernelLog;
  const readBootId = dependencies.readBootId ?? readCurrentBootId;
  const setIntervalFn = dependencies.setIntervalFn ?? setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = dependencies.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = dependencies.clearTimeoutFn ?? clearTimeout;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let latched;

  const rememberXid = (bootId, event) => {
    if (!latched || latched.bootId !== bootId) latched = Object.freeze({ bootId, event });
  };

  async function snapshot(bootId, phase) {
    let text;
    try { text = await kernelLog(); }
    catch (error) { throw new Error(`cannot establish required Xid guard during ${phase}: ${messageOf(error)}`); }
    const event = firstNvidiaXid(text);
    if (event) {
      rememberXid(bootId, event);
      throw xidStop(event, phase);
    }
  }

  async function runLive({ command, args, cwd, environment, failureLabel, pollMs, teardownGraceMs, bootId }) {
    return new Promise((resolve, reject) => {
      let monitor;
      let child;
      let poll;
      let teardownTimer;
      let failure;
      let childClosed = false;
      let monitorClosed = false;
      let childCode;
      let childSignal;
      let ending = false;
      let pollInFlight = false;
      let followerTail = "";
      let settled = false;

      const reportTeardownError = (label, error) => {
        const teardownFailure = new Error(`${label} teardown failed: ${messageOf(error)}`);
        if (!failure) failure = teardownFailure;
        else stderr.write(`[xid-guard] ${teardownFailure.message}\n`);
      };

      const armTeardown = () => {
        if (teardownTimer !== undefined) return;
        teardownTimer = setTimeoutFn(() => {
          try { if (child && !childClosed) child.kill("SIGKILL"); } catch (error) { reportTeardownError("capture child", error); }
          try { if (monitor && !monitorClosed) monitor.kill("SIGKILL"); } catch (error) { reportTeardownError("live Xid monitor", error); }
        }, teardownGraceMs);
        teardownTimer?.unref?.();
      };

      const fail = (error, xidEvent) => {
        if (failure || settled) return;
        failure = error instanceof Error ? error : new Error(String(error));
        if (xidEvent) rememberXid(bootId, xidEvent);
        ending = true;
        if (!child) childClosed = true;
        try { if (child && !childClosed) child.kill("SIGTERM"); } catch (killError) { reportTeardownError("capture child", killError); }
        try { if (monitor && !monitorClosed) monitor.kill("SIGTERM"); } catch (killError) { reportTeardownError("live Xid monitor", killError); }
        armTeardown();
      };

      const finish = () => {
        if (settled || !childClosed || !monitorClosed) return;
        settled = true;
        if (poll !== undefined) clearIntervalFn(poll);
        if (teardownTimer !== undefined) clearTimeoutFn(teardownTimer);
        if (failure) reject(failure);
        else if (childCode !== 0) reject(new Error(`${failureLabel} exited ${childCode ?? childSignal}`));
        else resolve();
      };

      try {
        monitor = spawnProcess("journalctl", FOLLOWER_ARGS, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        monitor.stdout.on("data", (chunk) => {
          followerTail += String(chunk);
          if (followerTail.length > 64 * 1024 && !/[\r\n]/.test(followerTail)) {
            fail(new Error("live Xid monitor emitted an unterminated oversized record"));
            return;
          }
          const lines = followerTail.split(/\r?\n/);
          followerTail = lines.pop() ?? "";
          const event = firstNvidiaXid(lines.join("\n"));
          if (event) fail(xidStop(event, "live"), event);
        });
        monitor.stderr.on("data", (chunk) => stderr.write(chunk));
        monitor.on("error", (error) => fail(new Error(`live Xid monitor failed: ${messageOf(error)}`)));
        monitor.on("close", (code, signal) => {
          if (followerTail) {
            const event = firstNvidiaXid(followerTail);
            if (event) fail(xidStop(event, "live"), event);
          }
          monitorClosed = true;
          if (!ending && !childClosed) fail(new Error(`live Xid monitor exited before capture completion: ${code ?? signal}`));
          finish();
        });

        // Close the preflight-to-follower attachment race before the capture process exists. The
        // current-boot snapshot is taken only after the follower listeners are installed, so an
        // Xid is covered by the snapshot, the follower, or both; `-n 0` can no longer skip the gap.
        void (async () => {
          let baseline;
          try { baseline = await kernelLog(); }
          catch (error) {
            fail(new Error(`follower-bound Xid baseline failed: ${messageOf(error)}`));
            finish();
            return;
          }
          const baselineXid = firstNvidiaXid(baseline);
          if (baselineXid) {
            fail(xidStop(baselineXid, "live"), baselineXid);
            finish();
            return;
          }
          if (failure || monitorClosed) { finish(); return; }
          try {
            child = spawnProcess(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (chunk) => stdout.write(chunk));
            child.stderr.on("data", (chunk) => stderr.write(chunk));
            child.on("error", (error) => fail(new Error(`${failureLabel} failed to start: ${messageOf(error)}`)));
            child.on("close", (code, signal) => {
              childClosed = true;
              childCode = code;
              childSignal = signal;
              ending = true;
              try { if (!monitorClosed) monitor.kill("SIGTERM"); } catch (error) { fail(new Error(`live Xid monitor teardown failed: ${messageOf(error)}`)); }
              armTeardown();
              finish();
            });
          } catch (error) {
            fail(new Error(`${failureLabel} failed to start: ${messageOf(error)}`));
            finish();
            return;
          }

          poll = setIntervalFn(async () => {
            if (pollInFlight || failure || childClosed) return;
            pollInFlight = true;
            try {
              const event = firstNvidiaXid(await kernelLog());
              if (event) fail(xidStop(event, "live"), event);
            } catch (error) {
              fail(error instanceof Error && /NVIDIA Xid detected/.test(error.message)
                ? error
                : new Error(`live Xid polling failed: ${messageOf(error)}`));
            } finally { pollInFlight = false; }
          }, pollMs);
          poll?.unref?.();
        })();
      } catch (error) {
        fail(new Error(`cannot establish required live Xid guard: ${messageOf(error)}`));
        if (!child) childClosed = true;
        if (!monitor) monitorClosed = true;
        finish();
      }
    });
  }

  async function run(spec) {
    const command = spec?.command;
    const args = spec?.args;
    const cwd = spec?.cwd;
    const environment = spec?.environment;
    const failureLabel = spec?.failureLabel ?? "guarded native capture";
    const pollMs = spec?.pollMs ?? NVIDIA_XID_POLL_MS;
    const teardownGraceMs = spec?.teardownGraceMs ?? 1_000;
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args) || typeof cwd !== "string" || !environment || typeof environment !== "object") {
      throw new TypeError("native Xid guard requires command, args, cwd, and environment");
    }
    if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 1_000 || !Number.isSafeInteger(teardownGraceMs) || teardownGraceMs < 10 || teardownGraceMs > 10_000) {
      throw new RangeError("native Xid guard timing is outside its bounded safety contract");
    }

    const bootId = await readBootId();
    if (latched?.bootId === bootId) throw xidStop(latched.event, "preflight");
    await snapshot(bootId, "preflight");
    const confirmedBootId = await readBootId();
    if (confirmedBootId !== bootId) throw new Error("Linux boot identity changed during Xid preflight; capture was not started");

    let liveFailure;
    try { await runLive({ command, args, cwd, environment, failureLabel, pollMs, teardownGraceMs, bootId }); }
    catch (error) { liveFailure = error; }

    let postflightFailure;
    try {
      const postflightBootId = await readBootId();
      if (postflightBootId !== bootId) throw new Error("Linux boot identity changed during native capture; stop and do not retry until the new boot is audited");
      await snapshot(bootId, "postflight");
    } catch (error) { postflightFailure = error; }
    if (postflightFailure) throw postflightFailure;
    if (liveFailure) throw liveFailure;
    return guardEvidence(bootId, pollMs);
  }

  return Object.freeze({ run });
}

const systemGuard = createNvidiaXidGuard();

export function runNativeCaptureWithXidGuard(spec) {
  return systemGuard.run(spec);
}
