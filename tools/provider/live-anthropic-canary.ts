import { randomUUID } from "node:crypto";

import { installOps, type EngineOps } from "../../js/src/engine.ts";
import { AnthropicProvider } from "../../js/src/agents/llm.ts";

const OFFICIAL_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel("live provider canary response exceeded its hard cap");
      throw new Error(`live provider canary response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(item.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

export interface LiveAnthropicCanaryEnvironment {
  readonly LIMINA_LIVE_PROVIDER_CANARY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly LIMINA_ANTHROPIC_CANARY_MODEL?: string;
  readonly LIMINA_ANTHROPIC_CANARY_MAX_TOKENS?: string;
}

export interface LiveAnthropicCanaryResult {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

/**
 * Metered, opt-in provider-drift canary. It exercises the production
 * AnthropicProvider request/response code while keeping the API key in process
 * memory. It is intentionally excluded from deterministic CI and never runs
 * merely because a key happens to exist.
 */
export async function runLiveAnthropicCanary(
  environment: LiveAnthropicCanaryEnvironment,
  fetchImpl: FetchLike = fetch,
): Promise<LiveAnthropicCanaryResult> {
  if (environment.LIMINA_LIVE_PROVIDER_CANARY !== "1") {
    throw new Error("live Anthropic canary is disabled; set LIMINA_LIVE_PROVIDER_CANARY=1 explicitly");
  }
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  const model = environment.LIMINA_ANTHROPIC_CANARY_MODEL?.trim();
  if (!apiKey) throw new Error("live Anthropic canary requires ANTHROPIC_API_KEY");
  if (!model) throw new Error("live Anthropic canary requires LIMINA_ANTHROPIC_CANARY_MODEL");
  const maxTokens = Number(environment.LIMINA_ANTHROPIC_CANARY_MAX_TOKENS ?? "16");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 64) {
    throw new Error("LIMINA_ANTHROPIC_CANARY_MAX_TOKENS must be an integer from 1 through 64");
  }

  installOps({
    async op_http_post_headers(url: string, body: string, headersJson: string): Promise<string> {
      if (url !== OFFICIAL_MESSAGES_URL) throw new Error("live Anthropic canary refused a non-official endpoint");
      const headers = JSON.parse(headersJson) as Record<string, string>;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: controller.signal,
        });
        const text = await boundedResponseText(response);
        if (!response.ok) throw new Error(`anthropic canary HTTP ${response.status}: ${text.slice(0, 512)}`);
        return text;
      } finally { clearTimeout(timeout); }
    },
    op_sleep_ms(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 2_000))));
    },
  } as unknown as EngineOps);

  const nonce = randomUUID();
  const decision = await new AnthropicProvider(model, apiKey, { maxTokens }).decide({
    systemPrompt: "You are a metered API compatibility canary. Reply with one short plain-text sentence and call no tools.",
    userMessage: `Confirm provider compatibility for nonce ${nonce}.`,
    perception: { selfId: "provider_canary", nearby: [], recentEvents: [], tick: 0 },
    previousResults: [],
    tools: [],
  });
  const text = decision.text?.trim() ?? "";
  const usage = decision.usage;
  if (text.length === 0 || decision.toolCalls.length !== 0) {
    throw new Error("live Anthropic canary returned an invalid no-tool response");
  }
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? 0;
  if (![inputTokens, outputTokens, totalTokens].every(Number.isSafeInteger) || totalTokens < 1) {
    throw new Error("live Anthropic canary response omitted valid usage accounting");
  }
  return { model, inputTokens, outputTokens, totalTokens, latencyMs: decision.latencyMs ?? 0 };
}

if (import.meta.main) {
  const result = await runLiveAnthropicCanary(process.env);
  console.log(`live Anthropic canary OK: model=${result.model} tokens=${result.totalTokens} input=${result.inputTokens} output=${result.outputTokens} latencyMs=${result.latencyMs}`);
}
