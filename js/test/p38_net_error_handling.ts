import { ops } from "../src/engine.ts";
import { JSON_RPC_ERRORS } from "../src/mcp/protocol.ts";
import { NetClient, type JsonRpcMsg } from "../src/net/client.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import type { NetOps } from "../src/net/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p38_net_error_handling FAIL: " + message);
}

function parseMsg(line: string): JsonRpcMsg {
  return JSON.parse(line) as JsonRpcMsg;
}

class ScriptedTransport implements NetServerTransport {
  readonly sent: string[] = [];
  private accepted = false;
  private readonly inbound: string[];

  constructor(inbound: string[]) {
    this.inbound = [...inbound];
  }

  async accept(): Promise<number> {
    if (this.accepted) return ACCEPT_CLOSED;
    this.accepted = true;
    return 1;
  }

  async recv(_connId: number): Promise<string> {
    const next = this.inbound.shift();
    if (next !== undefined) return next;
    await ops.op_sleep_ms(20);
    return "";
  }

  async send(_connId: number, line: string): Promise<void> {
    this.sent.push(line);
  }

  async close(_connId: number): Promise<void> {}
}

const initializeLine = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { agentId: "agent", sessionId: "session", profile: "builder.readWrite" },
});
const toolsListLine = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const preInitializeSubscribe = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "state/subscribe", params: {} });
const repeatedInitialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "initialize",
  params: { agentId: "replacement", sessionId: "replacement", profile: "system.readonly" },
});

const transport = new ScriptedTransport([preInitializeSubscribe, initializeLine, repeatedInitialize, toolsListLine]);
const server = new AuthoritativeServer(transport, { sessionId: "p38_net_error_handling", tickMs: 1000 });
const registry = server.registry as unknown as { list: (permissions: ReadonlySet<string>) => unknown };
registry.list = () => {
  throw new Error("synthetic registry failure");
};
server.start();
await ops.op_sleep_ms(80);

assert(transport.sent.length >= 4, `server dropped the connection without replying to handler failure: ${transport.sent.length} sends`);
const preInitResponse = parseMsg(transport.sent[0]);
assert(preInitResponse.id === 0 && preInitResponse.error?.code === -32000,
  "state subscription before initialize must be rejected");
const initResponse = parseMsg(transport.sent[1]);
assert(initResponse.id === 1 && initResponse.error === undefined, "initialize did not succeed before the injected handler failure");
const repeatResponse = parseMsg(transport.sent[2]);
assert(repeatResponse.id === 3 && repeatResponse.error?.code === JSON_RPC_ERRORS.invalidRequest,
  "repeated initialize must not replace the bound identity");
const failureResponse = parseMsg(transport.sent[3]);
assert(failureResponse.id === 2, "handler failure response did not preserve the request id");
assert(failureResponse.error?.code === JSON_RPC_ERRORS.internalError,
  `handler failure returned ${failureResponse.error?.code}, expected ${JSON_RPC_ERRORS.internalError}`);
await server.shutdown();

let closed = false;
let recvCount = 0;
const fakeNet = {
  async op_net_send(_connId: number, _line: string): Promise<void> {},
  async op_net_recv(_connId: number): Promise<string> {
    recvCount += 1;
    if (recvCount === 1) return "{not-json";
    while (!closed) await ops.op_sleep_ms(10);
    return "";
  },
  async op_net_close(_connId: number): Promise<void> {
    closed = true;
  },
} as unknown as NetOps;

const ClientCtor = NetClient as unknown as { new(net: NetOps, connId: number): NetClient };
const client = new ClientCtor(fakeNet, 99);
void (client as unknown as { recvLoop: () => Promise<void> }).recvLoop();
const response = client.rawRequest("tools/list", {});
const timeout = ops.op_sleep_ms(80).then(() => "timeout" as const);
const outcome = await Promise.race([
  response.then(
    () => "resolved" as const,
    (err) => err instanceof Error ? err.message : String(err),
  ),
  timeout,
]);
closed = true;
await client.close();

assert(outcome !== "timeout", "malformed client input left an outstanding request pending indefinitely");
assert(outcome !== "resolved", "malformed client input must not resolve an unrelated pending request");
assert(String(outcome).includes("malformed JSON-RPC message"), `unexpected malformed-input rejection: ${String(outcome)}`);

ops.op_log("p38_net_error_handling OK: transport handler failures and malformed client input fail pending work explicitly");
