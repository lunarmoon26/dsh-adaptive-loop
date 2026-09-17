import { describe, expect, it } from "vitest";
import { collectNativeText, hasCodexGrant } from "../plugins/dal-native-text/src/index.js";
type StreamChunk = Parameters<typeof collectNativeText>[0] extends AsyncIterable<infer T> ? T : never;

async function* stream(values: unknown[]): AsyncIterable<StreamChunk> {
  for (const value of values) yield value as StreamChunk;
}
const block = { type: "block-end", index: 0, block: { type: "text", text: '{"answer":1}' } };
const stop = { type: "finish", reason: { kind: "stop" } };
describe("native text protocol", () => {
  it("recognizes native opaque grants rather than an invented oauth record kind, and rejects API-key records", () => {
    type Info = Parameters<typeof hasCodexGrant>[0][number];
    const key = "llm-pi-ai/openai-codex" as Info["key"];
    expect(hasCodexGrant([{ key, kind: "grant" }])).toBe(true);
    expect(hasCodexGrant([{ key, kind: "api-key" }])).toBe(false);
    expect(hasCodexGrant([{ key: "llm-pi-ai/other" as Info["key"], kind: "grant" }])).toBe(false);
    expect(hasCodexGrant([])).toBe(false);
  });
  it("requires complete text and preserves native usage without inventing billing", async () => {
    const result = await collectNativeText(stream([block, { type: "usage", usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 } }, stop]), 1024);
    expect(result).toEqual({ text: '{"answer":1}', usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 0 } });
    expect((await collectNativeText(stream([block, stop]), 1024)).usage).toBeNull();
  });
  it.each([
    [block], [block, { type: "finish", reason: { kind: "max-tokens" } }],
    [{ type: "tool-call-delta", index: 0, id: "call", name: "shell", argumentsDelta: "{}" }, stop],
    [block, stop, block],
    [{ type: "block-end", index: 0, block: { type: "tool-call", name: "shell" } }, stop],
  ])("rejects incomplete or capability-bearing output %#", async (...chunks) => {
    await expect(collectNativeText(stream(chunks), 1024)).rejects.toThrow();
  });
  it("bounds streamed reasoning and completed text", async () => {
    await expect(collectNativeText(stream([{ type: "reasoning-delta", text: "x".repeat(9000) }, block, stop]), 1024)).rejects.toThrow();
    await expect(collectNativeText(stream([block, stop]), 2)).rejects.toThrow();
  });
});
