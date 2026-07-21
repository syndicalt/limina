# Live provider drift canaries

Deterministic CI uses scripted provider responses. That verifies request framing,
response parsing, authorization, replay, and bounded agent-loop behavior, but it
cannot detect a remote provider changing its accepted model IDs or response
contract.

`tools/provider/live-anthropic-canary.ts` is the separately metered release
canary for that gap. It is deliberately not part of ordinary gates and will not
run merely because `ANTHROPIC_API_KEY` is present. A release operator explicitly
chooses the model and opts in:

```bash
LIMINA_LIVE_PROVIDER_CANARY=1 \
ANTHROPIC_API_KEY='...' \
LIMINA_ANTHROPIC_CANARY_MODEL='<approved-model-id>' \
LIMINA_ANTHROPIC_CANARY_MAX_TOKENS=16 \
bun tools/provider/live-anthropic-canary.ts
```

The canary calls only the official Anthropic Messages endpoint, rejects
redirects, caps the response at 1 MiB, times out after 30 seconds, allows at most
64 output tokens, requests no tools, and prints only model, usage, and latency.
It never prints or persists the API key or response text.

Run it before a release that enables the Anthropic provider, after changing the
approved model ID, and during provider-incident diagnosis. Store the timestamp,
model, exit status, and usage in release evidence; never store the environment
or process command containing the key. A failed or absent canary blocks only a
release that claims live Anthropic support—it does not make deterministic engine
CI nondeterministic or silently count as a pass.
