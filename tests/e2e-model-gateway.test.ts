import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRehearsalUpstream, gatewayReservation, GATEWAY_ROUTES, startGateway, validateGatewayFailure, validateSpendPolicy, type E2eSpendPolicy, type GatewayUpstream } from "../src/e2e-model-gateway.js";

const token = "test-capability-with-at-least-32-characters";
const policy = (provider: "openai" | "anthropic" = "openai"): E2eSpendPolicy => ({
  schema_version: "1.0.0", campaign_id: "campaign-test", budget_id: "budget-test", approval_id: "dec-test-approved", run_id: "run-test",
  provider, model: provider === "openai" ? "gpt-5.6-terra" : "claude-sonnet-5", provider_limit_microusd: provider === "openai" ? 6000000 : 5000000,
  max_request_bytes: 65536, max_response_bytes: 2097152, timeout_ms: 120000, max_output_tokens: 1024,
  pricing_profile: "reviewed-text-upper-rates-20260907-v1", token_bound_profile: "json-bytes-times-two-plus-8192-v1",
  input_microusd_per_token: provider === "openai" ? 5 : 4, output_microusd_per_token: provider === "openai" ? 18 : 10,
});
const body = (p = policy(), stream = false) => p.provider === "openai" ? { model: p.model, input: "hello", max_output_tokens: 1024, stream, store: false } : { model: p.model, messages: [{ role: "user", content: "hello" }], thinking: { type: "disabled" }, max_tokens: 1024, stream };
let root: string;
let gateways: Awaited<ReturnType<typeof startGateway>>[];
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), "dal-gateway-")); gateways = []; });
afterEach(async () => { await Promise.all(gateways.map(g => g.close())); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function start(p = policy(), upstream?: GatewayUpstream) {
  const gateway = await startGateway({ policy: p, ledgerRoot: root, token, mode: upstream ? "live" : "rehearsal", ...(upstream ? { upstream } : {}) });
  gateways.push(gateway);
  return gateway;
}
const post = (address: string, value: unknown, route = "/v1/responses", auth = token) => fetch(address + route, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(value) });
async function receipt(address: string) { return (await fetch(address + "/receipt", { headers: { authorization: `Bearer ${token}` } })).json(); }
const ok: GatewayUpstream = async () => Response.json({ status: "completed", output: [] });

describe("chg-dal-live-gateway-repair-20260908 diagnostics", () => {
  it("captures Anthropic authentication status even with zero forwarded response bytes", async () => {
    const p = policy("anthropic");
    const g = await start(p, async () => Response.json({ type: "error", error: { type: "authentication_error", message: token } }, { status: 401 }));
    await post(g.address, body(p), "/v1/messages");
    const r = await receipt(g.address);
    expect(r.process_counts.response_bytes).toBe(0);
    expect(r.failure_diagnostics.records[0]).toMatchObject({ reserved: true, upstream_status: 401, provider_error_type: "authentication_error", provider_error_code: null });
  });
  it.each([[401, "authentication_error"], [400, "invalid_request_error"], [429, "rate_limit_error"]] as const)("retains safe HTTP %s across restart", async (status, type) => {
    const g = await start(policy(), async () => Response.json({ error: { type, code: token, message: "private prompt" } }, { status }));
    expect((await post(g.address, body())).status).toBe(502);
    const r = await receipt(g.address);
    expect(r.failure_diagnostics.records).toEqual([{ stage: "upstream", code: "http_rejected", reserved: true, upstream_status: status, provider_error_type: type, provider_error_code: null }]);
    expect(() => validateGatewayFailure(r.failure_diagnostics.records[0])).not.toThrow();
    const next = await start(policy(), ok);
    expect((await receipt(next.address)).failure_diagnostics).toEqual(r.failure_diagnostics);
    expect(JSON.stringify(r)).not.toContain(token);
    const directories = await readdir(join(root, "gateway-failures"));
    const raw = await readFile(join(root, "gateway-failures", directories[0]!, "0.json"), "utf8");
    expect(raw).not.toContain(token); expect(raw).not.toContain("private prompt");
  });
  it.each(["malformed", "oversized", "quota"])("bounds non-OK %s error parsing", async kind => {
    const payload = kind === "malformed" ? "{private" : JSON.stringify({ error: { type: "rate_limit_error", code: "insufficient_quota", message: kind === "oversized" ? token.repeat(1000) : token } });
    const g = await start(policy(), async () => new Response(payload, { status: 429 }));
    await post(g.address, body());
    const r = (await receipt(g.address)).failure_diagnostics.records[0];
    expect(r.upstream_status).toBe(429);
    expect(r.provider_error_code).toBe(kind === "quota" ? "insufficient_quota" : null);
  });
  it("keeps network secrets out and distinguishes replay", async () => {
    const g = await start(policy(), async () => { throw Object.assign(new Error(token), { code: token }); });
    await post(g.address, body()); await post(g.address, body());
    const r = await receipt(g.address);
    expect(r.failure_diagnostics.records.map((x: { code: string }) => x.code)).toEqual(["network_exception", "replay_rejected"]);
    expect(r.failure_diagnostics.records[0].upstream_status).toBeNull();
    expect(JSON.stringify(r)).not.toContain(token);
  });
  it("records reasoning rejection before reservation and caps durable slots", async () => {
    const upstream = vi.fn(ok); const g = await start(policy(), upstream);
    for (let i = 0; i < 36; i++) await post(g.address, { ...body(), input: [{ type: "reasoning", encrypted_content: token }] });
    const r = await receipt(g.address);
    expect(r.reservations).toBe(0); expect(upstream).not.toHaveBeenCalled();
    expect(r.failure_diagnostics.records).toHaveLength(32); expect(r.failure_diagnostics.dropped_count).toBe(4);
    expect(r.failure_diagnostics.records[0]).toMatchObject({ stage: "admission", code: "reasoning_denied", reserved: false });
    const directories = await readdir(join(root, "gateway-failures"));
    expect(await readdir(join(root, "gateway-failures", directories[0]!))).toHaveLength(33);
    const next = await start(policy(), ok);
    expect((await receipt(next.address)).failure_diagnostics.dropped_count).toBe(1);
    expect(await (await fetch(g.address + "/health")).json()).toEqual({ ready: true });
    expect(await (await fetch(g.address + "/receipt")).json()).toEqual({ error: "gateway_request_failed" });
  });
  it("distinguishes budget exhaustion", async () => {
    const g = await start({ ...policy(), provider_limit_microusd: 1 }, ok);
    await post(g.address, body());
    expect((await receipt(g.address)).failure_diagnostics.records[0]).toMatchObject({ stage: "reservation", code: "budget_exhausted", reserved: false });
  });
  it("distinguishes missing credentials using a replacement environment without reading real keys", async () => {
    const original = process.env;
    process.env = {};
    try {
      const g = await startGateway({ policy: policy(), ledgerRoot: root, token, mode: "live" }); gateways.push(g);
      await post(g.address, body());
      expect((await receipt(g.address)).failure_diagnostics.records[0]).toMatchObject({ stage: "credential", code: "credential_missing", reserved: true });
    } finally { process.env = original; }
  });
  it.each(["json", "mime"])("distinguishes response %s", async kind => {
    const g = await start(policy(), async () => new Response("{", { headers: { "content-type": kind === "json" ? "application/json" : "text/plain" } }));
    try { await (await post(g.address, body())).text(); } catch { /* Deliberate partial response. */ }
    expect((await receipt(g.address)).failure_diagnostics.records[0]).toMatchObject({ code: kind === "json" ? "response_json" : "response_content_type", upstream_status: 200 });
  });
  it("rejects hostile diagnostic fields rather than projecting arbitrary strings", () => {
    const safe = { stage: "auth", code: "auth_denied", reserved: false, upstream_status: null, provider_error_type: null, provider_error_code: null };
    for (const change of [{ extra: token }, { code: token }, { stage: token }, { provider_error_code: token }, { upstream_status: "401" }, { upstream_status: 401.5 }, { upstream_status: 999 }, { provider_error_type: token }]) {
      expect(() => validateGatewayFailure({ ...safe, ...change })).toThrow("GATEWAY_FAILURE_INVALID");
    }
  });
  it("keeps protected receipt readable after outcome persistence fails", async () => {
    await writeFile(join(root, "gateway-outcomes"), "blocked");
    const g = await start(policy(), ok);
    await (await post(g.address, body())).text();
    await vi.waitFor(async () => expect((await receipt(g.address)).failure_diagnostics.records).toContainEqual({ stage: "persistence", code: "persistence_failed", reserved: true, upstream_status: 200, provider_error_type: null, provider_error_code: null }));
    expect((await post(g.address, { ...body(), input: "next" })).status).toBe(400);
    expect((await receipt(g.address)).reservations).toBe(1);
  });
  it("applies the original timeout to non-OK body reads and retains observed status", async () => {
    const g = await start(policy(), async () => new Response(new ReadableStream({ start() {} }), { status: 401 }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = post(g.address, body());
      // Wait for reservation without advancing the gateway deadline.
      await vi.waitFor(async () => expect((await receipt(g.address)).reservations).toBe(1));
      await vi.advanceTimersByTimeAsync(120001);
      expect((await pending).status).toBe(502);
    } finally { vi.useRealTimers(); }
    expect((await receipt(g.address)).failure_diagnostics.records[0]).toMatchObject({ stage: "cancel", code: "timeout", upstream_status: 401 });
  });
});

describe("chg-dal-paid-e2e-preflight-20260907 model gateway", () => {
  it.each([undefined, null, {}, { type: "adaptive" }, { type: "enabled", budget_tokens: 1024 }, { type: "disabled", display: "omitted" }])("requires explicit Anthropic disabled thinking before reservation", async thinking => {
    const transport = vi.fn(ok); const p = policy("anthropic"); const g = await start(p, transport);
    expect((await post(g.address, { ...body(p), thinking }, "/v1/messages")).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    expect((await receipt(g.address)).reservations).toBe(0);
  });
  it("forwards explicit Anthropic off unchanged", async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).thinking).toEqual({ type: "disabled" });
      return Response.json({ type: "message", stop_reason: "end_turn" });
    });
    const p = policy("anthropic"); const g = await start(p, transport);
    expect((await post(g.address, body(p), "/v1/messages")).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects compact numeric schemas that expand beyond the charged-byte ceiling", async () => {
    const transport = vi.fn(ok); const g = await start(policy(), transport);
    const wire = JSON.stringify(body()).slice(0, -1) + ',"tools":[{"type":"function","name":"numeric","parameters":{"enum":[' + Array(4000).fill("1e20").join(",") + ']}}]}';
    expect(Buffer.byteLength(wire)).toBeLessThan(65536);
    const response = await fetch(g.address + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: wire });
    expect(response.status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    expect((await receipt(g.address)).reservations).toBe(0);
  });
  it.each(["openai", "anthropic"] as const)("validates explicit %s policy and conservative reservation", provider => {
    const p = policy(provider);
    expect(() => validateSpendPolicy(p)).not.toThrow();
    expect(gatewayReservation(p, 65536)).toBe(139264 * p.input_microusd_per_token + 1024 * p.output_microusd_per_token);
    expect(139264 + 1024).toBeLessThan(200000);
  });
  it.each(["provider_limit_microusd", "campaign_id", "pricing_profile", "token_bound_profile", "max_output_tokens"])("has no implicit %s", field => {
    const p = { ...policy() } as Record<string, unknown>; delete p[field];
    expect(() => validateSpendPolicy(p)).toThrow();
  });
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "6000000"])("rejects unsafe cap %s", cap => {
    expect(() => validateSpendPolicy({ ...policy(), provider_limit_microusd: cap })).toThrow();
  });
  it.each([
    { model: "wrong" }, { max_output_tokens: 1025 }, { max_output_tokens: 0 }, { previous_response_id: "resp_old" },
    { conversation: "stored" }, { background: true }, { service_tier: "priority" }, { store: true },
    { tools: [{ type: "web_search" }] }, { tools: [{ type: "code_interpreter" }] },
    { input: [{ type: "item_reference", id: "old" }] },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://invalid.test/image" }] }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "stored" }] }] },
    { tools: [{ type: "function", name: "remote", parameters: { $ref: "https://invalid.test/schema" } }] },
    { reasoning: { effort: "high" } }, { reasoning: { effort: "none", summary: "auto" } },
    { prompt_cache_options: { mode: "implicit" } }, { prompt_cache_options: { mode: "explicit", retention: "24h" } },
    { text: { format: { type: "json_schema", schema: { $ref: "https://invalid.test" } } } },
    { input: [{ type: "reasoning", id: "rs_old", encrypted_content: "opaque" }] },
    { input: [{ type: "function_call", id: "fc_old", call_id: "call_old", name: "get_order" }] },
    { input: [{ type: "message", role: "assistant", id: "msg_old" }] },
    { input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "complete", annotations: [{ type: "url_citation", url: "https://invalid.test" }] }] }] },
  ])("rejects disallowed body before reservation %j", async change => {
    const transport = vi.fn(ok); const g = await start(policy(), transport);
    expect((await post(g.address, { ...body(), ...change })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled(); expect((await receipt(g.address)).reservations).toBe(0);
  });
  it.each([
    { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://invalid.test" } }] }] },
    { messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "old" } }] }] },
    { tools: [{ type: "computer_20250124", name: "computer" }] }, { container: "stored" }, { betas: ["batch"] },
    { thinking: { type: "adaptive" } },
    { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hidden", signature: "opaque" }] }] },
    { tools: [{ name: "get_order", input_schema: {}, eager_input_streaming: "true" }] },
    { tools: [{ name: "get_order", input_schema: {}, eager_input_streaming: true, defer_loading: true }] },
    { tools: [{ name: "get_order", input_schema: {}, eager_input_streaming: true, cache_control: { type: "ephemeral" } }] },
  ])("rejects Anthropic media and stored inputs %j", async change => {
    const p = policy("anthropic"); const transport = vi.fn(ok); const g = await start(p, transport);
    expect((await post(g.address, { ...body(p), ...change }, "/v1/messages")).status).toBe(400);
    expect(transport).not.toHaveBeenCalled(); expect((await receipt(g.address)).reservations).toBe(0);
  });
  it("health is public, receipts protected, wrong routes and auth never reserve", async () => {
    const transport = vi.fn(ok); const g = await start(policy(), transport);
    expect((await fetch(g.address + "/health")).status).toBe(200);
    expect((await fetch(g.address + "/receipt")).status).toBe(400);
    for (const route of ["/v1/messages", "/v1/responses?x=1", "/v1/batches", "/https://invalid.test"]) expect((await post(g.address, body(), route)).status).toBe(400);
    expect((await post(g.address, body(), "/v1/responses", "wrong")).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it("admits SDK inline replay metadata but charges every supplied byte", async () => {
    const transport = vi.fn(ok); const p = policy(); const g = await start(p, transport);
    const input = { ...body(p), reasoning: { effort: "none" }, prompt_cache_options: { mode: "explicit" }, text: { format: { type: "json_object" } },
      input: [
        { role: "user", content: [{ type: "input_text", text: "read order" }] },
        { type: "function_call", id: "fc_rehearsal", call_id: "call_rehearsal", name: "get_order", arguments: '{"order_id":"o-1001"}' },
        { type: "function_call_output", call_id: "call_rehearsal", output: "inline tool output" },
        { type: "message", role: "assistant", id: "msg_rehearsal", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "DONE", annotations: [] }] },
      ],
    };
    expect((await post(g.address, input)).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual(input);
    expect((await receipt(g.address)).reserved_microusd).toBe(gatewayReservation(p, Buffer.byteLength(JSON.stringify(input))));
  });
  it("admits Anthropic eager inline tool streaming without cache or deferred tools", async () => {
    const p = policy("anthropic"); const g = await start(p);
    const input = { ...body(p, true), tools: [{ name: "get_order", description: "read", input_schema: { type: "object", properties: { order_id: { type: "string" } } }, eager_input_streaming: true, strict: true }] };
    const response = await post(g.address, input, "/v1/messages");
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("get_order");
    expect(events).toContain('o-1001');
    expect((await receipt(g.address)).process_counts.completed).toBe(1);
  });
  it("counts actual chunked bytes before parsing", async () => {
    const transport = vi.fn(ok); const g = await start(policy(), transport);
    await new Promise<void>((resolve, reject) => {
      const req = request(g.address + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, res => { expect(res.statusCode).toBe(400); res.resume(); res.on("end", resolve); });
      req.on("error", e => (e as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve() : reject(e));
      req.write('{"input":"'); req.write("x".repeat(40000)); req.end("x".repeat(40000));
    });
    expect(transport).not.toHaveBeenCalled(); expect((await receipt(g.address)).reservations).toBe(0);
  });
  it("reserves before fixed-route transport and forwards no candidate credentials or headers", async () => {
    const transport = vi.fn<GatewayUpstream>(async (url, init) => {
      expect(url).toBe(GATEWAY_ROUTES.openai); expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toEqual({ "content-type": "application/json" });
      const names = await readdir(join(root, "budget-test", "openai", "reservations")); expect(names).toHaveLength(1);
      const record = await readFile(join(root, "budget-test", "openai", "reservations", names[0]!), "utf8");
      expect(record).not.toContain("hello"); expect(record).not.toContain(token);
      return ok(url, init);
    });
    const g = await start(policy(), transport); expect((await post(g.address, body())).status).toBe(200);
    const r = await receipt(g.address); expect(r.reserved_microusd).toBe(gatewayReservation(policy(), Buffer.byteLength(JSON.stringify(body())))); expect(r.process_counts.completed).toBe(1);
  });
  it("rejects duplicate retries including different JSON whitespace, retaining failed allocations", async () => {
    const transport = vi.fn<GatewayUpstream>(async () => { throw new Error("secret-provider-diagnostic"); });
    const g = await start(policy(), transport);
    const first = await post(g.address, body()); expect(first.status).toBe(502); expect(await first.text()).not.toContain("secret");
    const second = await fetch(g.address + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body(), null, 2) });
    expect(second.status).toBe(400); expect(transport).toHaveBeenCalledTimes(1);
    expect((await receipt(g.address)).process_counts.failed).toBe(1);
  });
  it("fails closed across concurrent gateways sharing a cap", async () => {
    const p = { ...policy(), provider_limit_microusd: 100000 }; const transport = vi.fn(ok);
    const a = await start(p, transport); const b = await start(p, transport);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(i % 2 ? a.address : b.address, { ...body(), input: `request-${i}` })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(1);
    expect((await receipt(a.address)).reserved_microusd).toBeLessThanOrEqual(100000);
  });
  it.each([301, 429, 500])("never retries upstream status %s or exposes headers/body", async status => {
    const transport = vi.fn<GatewayUpstream>(async () => new Response("secret diagnostic", { status, headers: { location: "https://invalid.test", "x-api-key": "secret" } }));
    const g = await start(policy(), transport); const r = await post(g.address, body());
    expect(r.status).toBe(502); expect(await r.text()).not.toContain("secret"); expect(r.headers.get("x-api-key")).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1); expect((await receipt(g.address)).reservations).toBe(1);
  });
  it.each(["openai", "anthropic"] as const)("passes native %s SSE bytes unchanged and supports nonstream fixtures", async provider => {
    const p = policy(provider); const fixture = createRehearsalUpstream(); const input = body(p, true);
    const expected = await (await createRehearsalUpstream()(GATEWAY_ROUTES[provider], { body: JSON.stringify(input) })).text();
    const g = await start(p, fixture); const route = new URL(GATEWAY_ROUTES[provider]).pathname;
    const result = await post(g.address, input, route); expect(await result.text()).toBe(expected);
    const second = await post(g.address, body(p), route); expect(await second.text()).toContain("DONE");
    expect((await receipt(g.address)).process_counts.completed).toBe(2);
  });
  it("rehearsal ignores global fetch and prohibits an injected network transport", async () => {
    const localFetch = globalThis.fetch;
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const g = await start();
    await expect(startGateway({ policy: policy(), ledgerRoot: root, token, mode: "rehearsal", upstream: ok })).rejects.toThrow();
    const result = await localFetch(g.address + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body()) });
    expect(result.status).toBe(200); expect(await result.text()).toContain("get_order");
    expect(network).not.toHaveBeenCalled();
  });
  it("accepts Anthropic capability header and complete custom-tool result inputs", async () => {
    const p = policy("anthropic"); const g = await start(p);
    const result = await fetch(g.address + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify({
      ...body(p), tools: [{ name: "get_order", input_schema: { type: "object", properties: { order_id: { type: "string" } } } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_order", input: { order_id: "ord-1001" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "status known" }] }] }],
    }) });
    expect(result.status).toBe(200); expect(await result.text()).toContain("tool_use");
  });
  it("accepts complete OpenAI custom function calls and text results", async () => {
    const g = await start(policy(), ok);
    const result = await post(g.address, { ...body(), tools: [{ type: "function", name: "get_order", parameters: { type: "object" }, strict: false }], input: [
      { type: "function_call", call_id: "call_1", name: "get_order", arguments: '{"order_id":"ord-1001"}' },
      { type: "function_call_output", call_id: "call_1", output: "status known" },
    ] });
    expect(result.status).toBe(200); await result.text();
  });
  it("caps continuous response bytes and cancels the reader", async () => {
    const cancel = vi.fn(); const transport: GatewayUpstream = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel }), { headers: { "content-type": "text/event-stream" } });
    const g = await start(policy(), transport); const r = await post(g.address, body(policy(), true));
    await expect(r.text()).rejects.toThrow(); expect(cancel).toHaveBeenCalled();
    const summary = await receipt(g.address); expect(summary.process_counts.failed).toBe(1); expect(summary.process_counts.response_bytes).toBe(2097152); expect(summary.reservations).toBe(1);
    expect(summary.failure_diagnostics.records[0].code).toBe("response_oversize");
  });
  it("caller disconnect aborts the full response transport and retains reservation", async () => {
    let signal: AbortSignal | undefined; let sent = false;
    const transport: GatewayUpstream = async (_, init) => { signal = init.signal as AbortSignal; return new Response(new ReadableStream({ pull(c) { if (!sent) { c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n")); sent = true; } } }), { headers: { "content-type": "text/event-stream" } }); };
    const g = await start(policy(), transport); const controller = new AbortController();
    const r = await fetch(g.address + "/v1/responses", { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body(policy(), true)) });
    await r.body!.getReader().read(); controller.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect((await receipt(g.address)).reservations).toBe(1);
    expect((await receipt(g.address)).failure_diagnostics.records[0].code).toBe("disconnect");
  });
  it("full-response timeout aborts a stalled stream without refund", async () => {
    let signal: AbortSignal | undefined;
    const transport: GatewayUpstream = async (_, init) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    };
    const g = await start(policy(), transport);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const r = await post(g.address, body(policy(), true));
      const reading = r.text().catch(() => "aborted");
      await vi.advanceTimersByTimeAsync(120001);
      expect(signal?.aborted).toBe(true);
      expect(await reading).toBe("aborted");
    } finally { vi.useRealTimers(); }
    expect((await receipt(g.address)).reservations).toBe(1);
    expect((await receipt(g.address)).failure_diagnostics.records[0].code).toBe("timeout");
  });
  it("records truncated SSE as failure without refund", async () => {
    const g = await start(policy(), async () => new Response('data: {"type":"response.created"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    try { await (await post(g.address, body(policy(), true))).text(); } catch { /* premature termination is intentional */ }
    const r = await receipt(g.address); expect(r.process_counts.failed).toBe(1); expect(r.reservations).toBe(1);
    expect(r.failure_diagnostics.records[0].code).toBe("sse_missing_terminal");
    await vi.waitFor(async () => {
      const names = await readdir(join(root, "gateway-outcomes")); expect(names).toHaveLength(1);
      const summary = JSON.parse(await readFile(join(root, "gateway-outcomes", names[0]!), "utf8"));
      expect(summary.outcome).toBe("failed_or_partial"); expect(JSON.stringify(summary)).not.toContain("response.created");
    });
  });
  it("receipt detects corruption and restart reads durable totals", async () => {
    const g = await start(policy(), ok); await post(g.address, body());
    const next = await start(policy(), ok); expect((await receipt(next.address)).reservations).toBe(1);
    const directory = join(root, "budget-test", "openai", "reservations"); const names = await readdir(directory);
    await writeFile(join(directory, names[0]!), "{}");
    expect((await fetch(next.address + "/receipt", { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
    expect((await post(next.address, { ...body(), input: "next" })).status).toBe(400);
  });
});
