// Editor-host security boundary: an editor-facing authoritative server can require
// a per-process initialize token and can restrict the profiles accepted on that
// listener. This prevents an arbitrary browser page from connecting to localhost
// and minting a privileged editor/coordinator session just by choosing a profile.

import { ops } from "../src/engine.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient, type JsonRpcMsg } from "../src/net/client.ts";
import type { NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p7_editor_auth FAIL: " + message);
}

function forbidden(msg: JsonRpcMsg): boolean {
  return msg.error !== undefined && msg.error.code === -32001;
}

const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const url = `ws://127.0.0.1:${port}/`;

const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p7_editor_auth",
  seed: 0xed170,
  tickMs: 8,
  initializeAuthToken: "editor-secret",
  allowedProfiles: new Set(["reviewer", "builder.review"]),
});
server.start();

const noToken = await NetClient.connect(net, url);
const wrongProfile = await NetClient.connect(net, url);
const ok = await NetClient.connect(net, url);

const deniedMissing = await noToken.initialize("evil_page", "ses_missing", "reviewer");
assert(forbidden(deniedMissing), "initialize without the editor token must be forbidden");

const deniedProfile = await wrongProfile.rawRequest("initialize", {
  agentId: "evil_page",
  sessionId: "ses_wrong_profile",
  profile: "builder.readWrite",
  authToken: "editor-secret",
});
assert(forbidden(deniedProfile), "initialize with a disallowed profile must be forbidden");

const accepted = await ok.rawRequest("initialize", {
  agentId: "human_editor",
  sessionId: "ses_ok",
  profile: "reviewer",
  authToken: "editor-secret",
});
assert(accepted.error === undefined, "initialize with token and allowed profile should succeed: " + JSON.stringify(accepted));
assert((accepted.result as { session?: { profile?: string } }).session?.profile === "reviewer",
  "accepted session did not bind the requested reviewer profile");

await noToken.close();
await wrongProfile.close();
await ok.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log("p7_editor_auth OK: initialize requires the editor token and rejects profiles outside the listener allowlist");
