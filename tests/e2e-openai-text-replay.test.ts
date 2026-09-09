import { describe, expect, it, vi } from "vitest";
import { installOpenAiTextReplay, projectOpenAiTextReplay } from "../src/e2e-openai-text-replay.js";

const url = "http://dal-model-gateway:8787/v1/responses";
const reasoning = { id: "rs_placeholder", type: "reasoning", content: [], summary: [], encrypted_content: "opaque-placeholder-not-a-secret" };
const call = { type: "function_call", id: "fc_placeholder", call_id: "call_placeholder", name: "skill", arguments: '{"name":"workflow"}' };
const output = { type: "function_call_output", call_id: "call_placeholder", output: "visible workflow instructions" };
const body = (input: unknown = [reasoning, call, output]) => ({ model: "gpt-5.6-terra", store: false, stream: true, max_output_tokens: 1024, input });

describe("OpenAI empty-visible reasoning replay repair", () => {
  it("removes opaque replay and pairing IDs, preserving the complete tool exchange", () => {
    const wire = JSON.stringify(body());
    const projected = JSON.parse(projectOpenAiTextReplay(wire));
    expect(projected.reasoning).toEqual({ effort: "none" });
    expect(projected.input).toEqual([{ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments }, output]);
    expect(projected.max_output_tokens).toBe(1024);
    expect(projected.stream).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("opaque-placeholder");
    expect(JSON.parse(wire).input).toEqual([reasoning, call, output]);
  });
  it("sets explicit none on the initial wire request without changing visible content", () => {
    const initial = body([{ role: "developer", content: "JSON instructions" }, { role: "user", content: "task" }]);
    expect(JSON.parse(projectOpenAiTextReplay(JSON.stringify(initial)))).toEqual({ ...initial, reasoning: { effort: "none" } });
  });
  it("preserves native call ID metadata if there is no paired reasoning to remove", () => {
    expect(JSON.parse(projectOpenAiTextReplay(JSON.stringify(body([call, output])))).input).toEqual([call, output]);
  });
  it.each([
    { ...reasoning, summary: [{ type: "summary_text", text: "visible reasoning" }] },
    { ...reasoning, content: [{ type: "reasoning_text", text: "visible reasoning" }] },
    { ...reasoning, summary: "visible text" },
  ])("never silently drops visible or malformed reasoning", item => {
    expect(() => projectOpenAiTextReplay(JSON.stringify(body([item, call, output])))).toThrow("E2E_TEXT_REPLAY_VISIBLE_REASONING");
  });
  it.each([{ ...reasoning, unknown: true }, { ...reasoning, encrypted_content: 10 }])("rejects unsupported reasoning metadata", item => {
    expect(() => projectOpenAiTextReplay(JSON.stringify(body([item])))).toThrow("E2E_TEXT_REPLAY_REASONING_SHAPE");
  });
  it.each([{ model: "other" }, { store: true }, { reasoning: { effort: "high" } }, { reasoning: { effort: "none", summary: "auto" } }])("rejects policy changes", change => {
    expect(() => projectOpenAiTextReplay(JSON.stringify({ ...body(), ...change }))).toThrow("E2E_TEXT_REPLAY_POLICY");
  });
  it("is idempotent and bounded", () => {
    const once = projectOpenAiTextReplay(JSON.stringify(body()));
    expect(projectOpenAiTextReplay(once)).toBe(once);
    expect(() => projectOpenAiTextReplay(JSON.stringify(body("x".repeat(65536))))).toThrow("E2E_TEXT_REPLAY_TOO_LARGE");
    expect(() => projectOpenAiTextReplay("not-json-secret-placeholder")).toThrow("E2E_TEXT_REPLAY_INVALID_JSON");
  });
  it("adapts only the fixed internal Responses endpoint and adjusts content length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const wrapped = installOpenAiTextReplay(fetcher);
    await wrapped(url, { method: "POST", headers: { authorization: "Bearer local-capability", "content-length": "1" }, body: JSON.stringify(body()) });
    const init = fetcher.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body)).input).toEqual([{ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments }, output]);
    expect(new Headers(init.headers).get("content-length")).toBeNull();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-capability");
  });
  it.each(["http://dal-model-gateway:8787/v1/messages", "https://api.openai.com/v1/responses", "http://example.invalid/v1/responses"])("leaves unrelated requests unchanged", async destination => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const init = { method: "POST", body: "unchanged" };
    await installOpenAiTextReplay(fetcher)(destination, init);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(destination, init);
  });
  it("rejects unsupported replay before invoking transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(installOpenAiTextReplay(fetcher)(url, { method: "POST", body: JSON.stringify(body([{ ...reasoning, summary: [{ text: "visible" }] }])) })).rejects.toThrow("E2E_TEXT_REPLAY_VISIBLE_REASONING");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
