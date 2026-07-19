import { describe, expect, test } from "bun:test";

import { runLiveAnthropicCanary } from "./live-anthropic-canary.ts";

const validResponse = JSON.stringify({
  content: [{ type: "text", text: "Provider compatibility confirmed." }],
  usage: { input_tokens: 19, output_tokens: 4 },
});

describe("metered Anthropic provider canary admission", () => {
  test("never runs from key presence alone", async () => {
    await expect(runLiveAnthropicCanary({
      ANTHROPIC_API_KEY: "secret",
      LIMINA_ANTHROPIC_CANARY_MODEL: "test-model",
    }, async () => new Response(validResponse))).rejects.toThrow("disabled");
  });

  test("requires an explicit model and a bounded token budget", async () => {
    await expect(runLiveAnthropicCanary({ LIMINA_LIVE_PROVIDER_CANARY: "1" }, async () => new Response(validResponse))).rejects.toThrow("ANTHROPIC_API_KEY");
    await expect(runLiveAnthropicCanary({
      LIMINA_LIVE_PROVIDER_CANARY: "1",
      ANTHROPIC_API_KEY: "secret",
    }, async () => new Response(validResponse))).rejects.toThrow("CANARY_MODEL");
    await expect(runLiveAnthropicCanary({
      LIMINA_LIVE_PROVIDER_CANARY: "1",
      ANTHROPIC_API_KEY: "secret",
      LIMINA_ANTHROPIC_CANARY_MODEL: "test-model",
      LIMINA_ANTHROPIC_CANARY_MAX_TOKENS: "65",
    }, async () => new Response(validResponse))).rejects.toThrow("1 through 64");
  });

  test("exercises production provider framing without exposing the key", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const result = await runLiveAnthropicCanary({
      LIMINA_LIVE_PROVIDER_CANARY: "1",
      ANTHROPIC_API_KEY: "secret",
      LIMINA_ANTHROPIC_CANARY_MODEL: "test-model",
      LIMINA_ANTHROPIC_CANARY_MAX_TOKENS: "8",
    }, async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));
      return new Response(validResponse, { status: 200 });
    });
    expect(capturedHeaders?.["x-api-key"]).toBe("secret");
    expect(capturedBody?.model).toBe("test-model");
    expect(capturedBody?.max_tokens).toBe(8);
    expect(result).toEqual({ model: "test-model", inputTokens: 19, outputTokens: 4, totalTokens: 23, latencyMs: expect.any(Number) });
  });
});
