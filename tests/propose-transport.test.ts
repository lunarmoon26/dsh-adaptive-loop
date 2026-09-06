import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../src/json.js";
import { assertSchema, SCHEMA_IDS } from "../src/schema.js";
import { DEEPSEEK_ENDPOINT, prepareChatRequest, REQUEST_LIMIT, RESPONSE_LIMIT, sendChatRequest, TIMEOUT_MS } from "../src/propose-transport.js";

const model = { provider: "deepseek-official", model: "deepseek-v4-flash" };
const prepared = () => prepareChatRequest({ task: "test", output_contract: "Return JSON" }, model);
const response = (message: unknown = { role: "assistant", content: "{}" }, finish_reason = "stop") =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message }] }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("versioned proposer request schema", () => {
  it("validates the complete persisted envelope using the local catalog", async () => {
    const value = prepared();
    expect(value.request).toMatchObject({ $schema: SCHEMA_IDS.proposerRequest, schema_version: "1.0.0" });
    await expect(assertSchema(SCHEMA_IDS.proposerRequest, JSON.parse(value.requestJson), "Proposer request")).resolves.toBeUndefined();
    expect(value.requestDigest).toBe(sha256(value.requestJson));
    const unversioned = { ...value.request };
    Reflect.deleteProperty(unversioned, "$schema");
    Reflect.deleteProperty(unversioned, "schema_version");
    expect(sha256(canonicalJson(unversioned))).not.toBe(value.requestDigest);
  });

  const mutations: Array<[string, (request: ReturnType<typeof prepared>["request"]) => void]> = [
    ["alternate route", (r) => { r.endpoint = "https://example.invalid/chat/completions"; }],
    ["provider", (r) => { r.provider = "other"; }],
    ["method", (r) => { r.method = "GET"; }],
    ["content type", (r) => { r.content_type = "text/plain"; }],
    ["credential designation", (r) => { r.credential_env = "OTHER_API_KEY"; }],
    ["schema identity", (r) => { Object.assign(r, { $schema: "https://example.invalid/schema" }); }],
    ["version", (r) => { r.schema_version = "2.0.0"; }],
    ["missing version", (r) => { Reflect.deleteProperty(r, "schema_version"); }],
    ["request bound", (r) => { r.limits.request_bytes++; }],
    ["response bound", (r) => { r.limits.response_bytes++; }],
    ["timeout", (r) => { r.limits.timeout_ms++; }],
    ["extra limit", (r) => { Object.assign(r.limits, { retries: 1 }); }],
    ["extra header", (r) => { Object.assign(r, { headers: { Authorization: "not-persistable" } }); }],
    ["tools", (r) => { Object.assign(r.body, { tools: [] }); }],
    ["streaming", (r) => { r.body.stream = true; }],
    ["output tokens", (r) => { r.body.max_tokens++; }],
    ["temperature", (r) => { r.body.temperature++; }],
    ["missing model", (r) => { Reflect.deleteProperty(r.body, "model"); }],
    ["system instructions", (r) => { r.body.messages[0]!.content = "changed"; }],
    ["user role", (r) => { r.body.messages[1]!.role = "tool"; }],
    ["extra message field", (r) => { Object.assign(r.body.messages[1]!, { tool_calls: [] }); }],
    ["extra message", (r) => { r.body.messages.push({ role: "user", content: "more" }); }],
    ["extra response format", (r) => { Object.assign(r.body.response_format, { extra: true }); }],
  ];
  it.each(mutations)("rejects %s without transport authority", async (_, mutate) => {
    const request = prepared().request;
    mutate(request);
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(assertSchema(SCHEMA_IDS.proposerRequest, request, "Proposer request"))
      .rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
    await expect(sendChatRequest(request)).rejects.toMatchObject({ code: "PROPOSE_REQUEST_INVALID" });
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("fixed DeepSeek transport", () => {
  it("canonically binds the complete request without credentials", () => {
    const a = prepared();
    expect(a).toEqual(prepared());
    expect(a.requestDigest).toBe(sha256(canonicalJson(a.request)));
    expect(a.request.body).toMatchObject({ stream: false, max_tokens: 2048, temperature: 0 });
    expect(a.request.body).not.toHaveProperty("tools");
    expect(a.requestJson).not.toContain("Authorization");
    for (const field of ["endpoint", "provider"] as const) {
      expect(sha256(canonicalJson({ ...a.request, [field]: "changed" }))).not.toBe(a.requestDigest);
    }
    expect(prepareChatRequest({ task: "changed" }, model).requestDigest).not.toBe(a.requestDigest);
    expect(prepareChatRequest({ task: "test" }, { ...model, model: "other" }).requestDigest).not.toBe(a.requestDigest);
  });

  it("rejects unknown providers, missing models and oversized requests", () => {
    expect(() => prepareChatRequest({}, { ...model, provider: "arbitrary" })).toThrow("deepseek-official");
    expect(() => prepareChatRequest({}, { ...model, model: "" })).toThrow("explicit");
    expect(() => prepareChatRequest("x".repeat(REQUEST_LIMIT), model)).toThrow("byte limit");
  });

  it("sends exactly one fixed POST with only the designated credential", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-test-key");
    vi.stubEnv("DSH_HOME", "/does-not-exist");
    const mock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", mock);
    const a = prepared();
    expect(await sendChatRequest(a.request)).toBe("{}");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(DEEPSEEK_ENDPOINT, {
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", Authorization: "Bearer offline-test-key" },
      body: canonicalJson(a.request.body),
    });
  });

  it("rejects mutated endpoint or instructions before fetching", async () => {
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    for (const kind of ["endpoint", "prompt"]) {
      const a = prepared();
      if (kind === "endpoint") a.request.endpoint = "https://example.invalid";
      else a.request.body.messages[0]!.content = "changed";
      await expect(sendChatRequest(a.request)).rejects.toMatchObject({ code: "PROPOSE_REQUEST_INVALID" });
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not load credentials from a profile or dotenv", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(sendChatRequest(prepared().request)).rejects.toMatchObject({ code: "PROPOSE_CREDENTIAL_MISSING" });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["http", "fetch", "json", "oversize-header", "oversize-stream"])("bounds and sanitizes %s errors without retries", async (kind) => {
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-test-key");
    const marker = "private-response-marker";
    const mock = vi.fn();
    if (kind === "fetch") mock.mockRejectedValue(new Error(marker));
    else if (kind === "http") mock.mockResolvedValue(new Response(marker, { status: 429 }));
    else if (kind === "json") mock.mockResolvedValue(new Response(marker));
    else if (kind === "oversize-header") mock.mockResolvedValue(new Response(marker, { headers: { "content-length": String(RESPONSE_LIMIT + 1) } }));
    else mock.mockResolvedValue(new Response("x".repeat(RESPONSE_LIMIT + 1)));
    vi.stubGlobal("fetch", mock);
    const result = sendChatRequest(prepared().request);
    await expect(result).rejects.toMatchObject({ code: kind.startsWith("oversize") ? "PROPOSE_RESPONSE_TOO_LARGE" : kind === "http" ? "PROPOSE_HTTP_ERROR" : "PROPOSE_TRANSPORT_FAILED" });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain(marker);
      expect(String(error)).not.toContain("offline-test-key");
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each(["tool", "function", "truncated", "multiple"])("rejects %s replies", async (kind) => {
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-test-key");
    const message = { role: "assistant", content: "{}", ...(kind === "tool" ? { tool_calls: [] } : {}), ...(kind === "function" ? { function_call: {} } : {}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(kind === "multiple" ? new Response('{"choices":[]}') : response(message, kind === "truncated" ? "length" : "stop")));
    await expect(sendChatRequest(prepared().request)).rejects.toMatchObject({ code: "PROPOSE_REPLY_INVALID" });
  });

  it.each(["headers", "body"])("times out through stalled %s", async (stage) => {
    vi.useFakeTimers(); vi.stubEnv("DEEPSEEK_API_KEY", "offline-test-key");
    const mock = vi.fn().mockImplementation(() => stage === "headers" ? new Promise(() => {}) :
      Promise.resolve(new Response(new ReadableStream({ start() {} }))));
    vi.stubGlobal("fetch", mock);
    const pending = sendChatRequest(prepared().request);
    const assertion = expect(pending).rejects.toMatchObject({ code: "PROPOSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![1].signal.aborted).toBe(true);
  });
});
