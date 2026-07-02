import { installOps, ops, type EngineOps } from "../src/engine.ts";
import { AnthropicProvider } from "../src/agents/llm.ts";
import type { Perception } from "../src/agents/agent.ts";

declare const Deno: { core: { ops: EngineOps } };

let captured:
  | { url: string; body: string; headersJson: string }
  | undefined;

installOps({
  ...Deno.core.ops,
  op_http_post_headers(url: string, body: string, headersJson: string): Promise<string> {
    captured = { url, body, headersJson };
    return Promise.resolve(JSON.stringify({
      content: [
        { type: "text", text: "I will query the scene." },
        { type: "tool_use", id: "toolu_1", name: "scene__queryEntities", input: { radius: 12 } },
      ],
      usage: { input_tokens: 11, output_tokens: 7 },
    }));
  },
} as EngineOps);

const provider = new AnthropicProvider("claude-test", "sk-test", {
  baseUrl: "https://api.anthropic.test",
  maxTokens: 123,
});
const perception: Perception = { selfId: "agt", nearby: [], recentEvents: [], tick: 42 };
const result = await provider.decide({
  systemPrompt: "Use tools.",
  perception,
  previousResults: [{ ok: true }],
  tools: [
    { name: "scene.queryEntities", description: "Query nearby entities", input_schema: { type: "object" } },
  ],
});

if (captured === undefined) throw new Error("AnthropicProvider did not call op_http_post_headers");
if (captured.url !== "https://api.anthropic.test/v1/messages") throw new Error(`unexpected URL: ${captured.url}`);

const headers = JSON.parse(captured.headersJson);
if (headers["x-api-key"] !== "sk-test") throw new Error("missing x-api-key header");
if (headers["anthropic-version"] !== "2023-06-01") throw new Error("missing anthropic-version header");
if (headers["content-type"] !== "application/json") throw new Error("missing content-type header");

const body = JSON.parse(captured.body);
if (body.model !== "claude-test") throw new Error("wrong model");
if (body.max_tokens !== 123) throw new Error("wrong max_tokens");
if (body.system[0].text !== "Use tools.") throw new Error("wrong system prompt");
if (body.system[0].cache_control?.type !== "ephemeral") throw new Error("system prompt not marked for prompt caching");
if (body.tools[0].name !== "scene__queryEntities") throw new Error("tool name was not encoded");
if (body.tools[body.tools.length - 1].cache_control?.type !== "ephemeral") throw new Error("tools block not marked for prompt caching");
const content = body.messages[0].content;
if (typeof content !== "string" || !content.includes("User request:")) {
  throw new Error("user message should be a natural 'User request:' instruction, not a JSON dump");
}
if (!content.includes('"ok":true')) {
  throw new Error("user message should carry prior tool results as context");
}

if (result.text !== "I will query the scene.") throw new Error(`wrong text: ${result.text}`);
if (result.usage?.totalTokens !== 18) throw new Error(`wrong token usage: ${JSON.stringify(result.usage)}`);
if (result.toolCalls.length !== 1) throw new Error(`wrong tool call count: ${result.toolCalls.length}`);
if (result.toolCalls[0].tool !== "scene.queryEntities") throw new Error(`tool name not decoded: ${result.toolCalls[0].tool}`);
if (result.toolCalls[0].input.radius !== 12) throw new Error("tool input not preserved");

ops.op_log("AnthropicProvider OK: request headers/body shaped and canned Messages response parsed");
