import { readFileSync, writeFileSync } from "node:fs";

const request = JSON.parse(readFileSync("/input/request.json", "utf8"));
const apiKey = readFileSync("/run/secret/anthropic-key", "utf8").trim();
if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) throw new Error("generation credential is invalid");
const model = process.env.ARCHITECT_MODEL;
if (!new Set(["claude-sonnet-5", "claude-opus-4-8"]).has(model)) throw new Error("generation model is not allowed");

const system = `You generate one self-contained Blender 4 Python source file as untrusted data.
Return exactly one fenced python block and no prose. The script receives --out /output/candidate.glb.
It must create a real-world-scale textured prop using bpy, ground it at Y=0, export one GLB to that
exact --out value, and use only Blender/Python standard modules. Do not read files, use the network,
spawn processes, inspect credentials, or select another output path. The execution sandbox enforces
these restrictions independently of this instruction.`;
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model,
    max_tokens: 16_000,
    system,
    messages: [{ role: "user", content: JSON.stringify({
      description: request.description,
      category: request.category,
      title: request.title,
    }) }],
  }),
});
const body = await response.text();
if (!response.ok) throw new Error(`Anthropic generation failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
const parsed = JSON.parse(body);
const text = (parsed.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text).join("\n");
const match = text.match(/^\s*```python\s*\n([\s\S]*?)\n```\s*$/);
if (!match) throw new Error("generation response must contain exactly one fenced Python source block");
const source = match[1] + "\n";
if (Buffer.byteLength(source) < 64 || Buffer.byteLength(source) > 512 * 1024 || source.includes("\0")) {
  throw new Error("generated Python source size is outside the allowed range");
}
writeFileSync("/generated/source.py", source, { encoding: "utf8", mode: 0o600, flag: "wx" });
writeFileSync("/generated/generation.json", JSON.stringify({
  schema: "limina.architect-generation/v1",
  model: parsed.model,
  stopReason: parsed.stop_reason,
  usage: parsed.usage,
}) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
