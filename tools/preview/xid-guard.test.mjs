import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createNvidiaXidGuard, firstNvidiaXid } from "./xid-guard.mjs";

class FakeProcess extends EventEmitter {
  constructor(kind, onKill) {
    super();
    this.kind = kind;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
    this.onKill = onKill;
  }
  kill(signal) {
    this.kills.push(signal);
    this.onKill?.(signal, this);
    return true;
  }
  close(code = 0, signal = null) { this.emit("close", code, signal); }
}

function harness({ logs = ["clean"], bootIds = ["boot-a"], arrange } = {}) {
  const processes = [];
  let logIndex = 0;
  let bootIndex = 0;
  const spawnProcess = (command, args) => {
    assert.ok(command === "journalctl" || command === "fake-capture", `unexpected process ${command}`);
    if (command === "journalctl") assert.deepEqual(args, ["-k", "-b", "-f", "-n", "0", "--no-pager", "-o", "cat"]);
    const process = new FakeProcess(command === "journalctl" ? "monitor" : "child", (_signal, self) => queueMicrotask(() => self.close(null, "SIGTERM")));
    processes.push(process);
    arrange?.(process, processes);
    return process;
  };
  const guard = createNvidiaXidGuard({
    spawnProcess,
    kernelLog: () => logs[Math.min(logIndex++, logs.length - 1)],
    readBootId: async () => bootIds[Math.min(bootIndex++, bootIds.length - 1)],
    stdout: { write() {} }, stderr: { write() {} },
  });
  const run = () => guard.run({ command: "fake-capture", args: ["--not-a-renderer"], cwd: "/private", environment: {}, failureLabel: "fake capture", pollMs: 50, teardownGraceMs: 50 });
  return { guard, processes, run };
}

test("firstNvidiaXid returns the first exact matching record", () => {
  assert.equal(firstNvidiaXid("noise\nNVRM: Xid (PCI:0000): 31, first\nNVRM: Xid 79, second"), "NVRM: Xid (PCI:0000): 31, first");
});

test("preflight Xid refuses before any process is spawned and latches the boot", async () => {
  const h = harness({ logs: ["NVRM: Xid 79, GPU has fallen off the bus", "clean"] });
  await assert.rejects(h.run(), /reboot before any native capture retry:.*Xid 79/);
  assert.equal(h.processes.length, 0);
  await assert.rejects(h.run(), /reboot before any native capture retry:.*Xid 79/);
  assert.equal(h.processes.length, 0);
});

test("unavailable preflight journal fails closed before process spawn", async () => {
  const h = harness();
  const guard = createNvidiaXidGuard({
    spawnProcess: () => { throw new Error("spawn must not happen"); },
    kernelLog: () => { throw new Error("journal denied"); },
    readBootId: async () => "boot-a",
  });
  await assert.rejects(guard.run({ command: "fake-capture", args: [], cwd: "/private", environment: {} }), /cannot establish required Xid guard during preflight: journal denied/);
  assert.equal(h.processes.length, 0);
});

test("live follower reconstructs split records, reports the exact first Xid, and settles once", async () => {
  const h = harness({ arrange(process) {
    if (process.kind === "child") queueMicrotask(() => {
      h.processes[0].stdout.emit("data", "NVRM: Xi");
      h.processes[0].stdout.emit("data", "d 31, GPU faulted\nNVRM: Xid 79, later\n");
    });
  } });
  await assert.rejects(h.run(), /Xid 31, GPU faulted/);
  assert.equal(h.processes[1].kills.filter((signal) => signal === "SIGTERM").length, 1);
});

test("follower-bound baseline Xid prevents capture child spawn and latches the exact event", async () => {
  const h = harness({ logs: ["clean", "NVRM: Xid 62, snapshot follower gap", "clean"] });
  await assert.rejects(h.run(), /Xid 62, snapshot follower gap/);
  assert.deepEqual(h.processes.map(({ kind }) => kind), ["monitor"]);
  await assert.rejects(h.run(), /reboot before any native capture retry:.*Xid 62, snapshot follower gap/);
  assert.deepEqual(h.processes.map(({ kind }) => kind), ["monitor"]);
});

test("redundant bounded poll catches an event missed by the follower", async () => {
  const h = harness({ logs: ["clean", "clean", "NVRM: Xid 43, poll caught it", "clean"] });
  await assert.rejects(h.run(), /Xid 43, poll caught it/);
});

test("redundant poll failure is fatal rather than silently disabling the backstop", async () => {
  let reads = 0;
  const h = harness({ logs: ["clean"] });
  const guard = createNvidiaXidGuard({
    spawnProcess: (command, args) => {
      const process = new FakeProcess(command === "journalctl" ? "monitor" : "child", (_signal, self) => queueMicrotask(() => self.close(null, "SIGTERM")));
      h.processes.push(process);
      return process;
    },
    kernelLog: () => { const read = reads++; if (read === 2) throw new Error("poll journal failed"); return "clean"; },
    readBootId: async () => "boot-a",
    stdout: { write() {} }, stderr: { write() {} },
  });
  await assert.rejects(guard.run({ command: "fake-capture", args: [], cwd: "/private", environment: {}, pollMs: 50, teardownGraceMs: 50 }), /live Xid polling failed: poll journal failed/);
});

test("monitor death is fatal and tears down the child", async () => {
  const h = harness({ arrange(process) {
    if (process.kind === "child") queueMicrotask(() => h.processes[0].close(1, null));
  } });
  await assert.rejects(h.run(), /live Xid monitor exited before capture completion: 1/);
  assert.ok(h.processes[1].kills.includes("SIGTERM"));
});

test("postflight Xid takes precedence over a successful child", async () => {
  const h = harness({ logs: ["clean", "clean", "NVRM: Xid 13, postflight"], arrange(process) {
    if (process.kind === "child") queueMicrotask(() => process.close(0));
  } });
  await assert.rejects(h.run(), /Xid detected after capture.*Xid 13, postflight.*do not retry until reboot/);
});

test("postflight Xid takes precedence over a simultaneous child failure", async () => {
  const h = harness({ logs: ["clean", "clean", "NVRM: Xid 32, race winner"], arrange(process) {
    if (process.kind === "child") queueMicrotask(() => process.close(7));
  } });
  await assert.rejects(h.run(), /Xid 32, race winner/);
});

test("boot identity drift refuses capture before spawn and after capture", async () => {
  const pre = harness({ bootIds: ["boot-a", "boot-b"] });
  await assert.rejects(pre.run(), /boot identity changed during Xid preflight/);
  assert.equal(pre.processes.length, 0);
  const post = harness({ bootIds: ["boot-a", "boot-a", "boot-b"], arrange(process) {
    if (process.kind === "child") queueMicrotask(() => process.close(0));
  } });
  await assert.rejects(post.run(), /boot identity changed during native capture/);
});

test("clean run tears down the monitor and returns immutable boot-bound evidence", async () => {
  const h = harness({ arrange(process) {
    if (process.kind === "child") queueMicrotask(() => process.close(0));
  } });
  const evidence = await h.run();
  assert.equal(evidence.bootId, "boot-a");
  assert.deepEqual(evidence.implementation.path, "tools/preview/xid-guard.mjs");
  assert.match(evidence.implementation.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(evidence.live.redundantPollMs, 50);
  assert.equal(evidence.live.follower, "journalctl-kernel-follow-current-boot");
  assert.ok(h.processes[0].kills.includes("SIGTERM"));
  assert.ok(Object.isFrozen(evidence));
});
