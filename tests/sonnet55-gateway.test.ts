import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayReservation, startGateway, validateSpendPolicy, type E2eSpendPolicy, type GatewayUpstream } from "../src/e2e-model-gateway.js";

const token = "synthetic-sonnet55-capability-long-enough";
const policy: E2eSpendPolicy = {
  schema_version: "1.0.0", campaign_id: "research-sonnet55-pilot", budget_id: "research-sonnet55-pilot",
  approval_id: "dec-synthetic-sonnet55", run_id: "run-synthetic", provider: "anthropic", model: "claude-sonnet-5-5",
  provider_limit_microusd: 10000000, max_request_bytes: 65536, max_response_bytes: 2097152, timeout_ms: 120000,
  max_output_tokens: 1024, pricing_profile: "reviewed-sonnet55-text-upper-rates-20261006-v1",
  token_bound_profile: "json-bytes-times-two-plus-8192-v1", input_microusd_per_token: 4, output_microusd_per_token: 10,
};
const body = (input = "Synthetic development hypothesis") => ({ model: policy.model, max_tokens: 1024,
  messages: [{ role: "user", content: input }], thinking: { type: "between_tools" }, stream: false });
const ok: GatewayUpstream = async () => Response.json({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic response" }] });
let root: string;
let gateways: Awaited<ReturnType<typeof startGateway>>[];
beforeEach(async () => { root = await mkdtemp("/tmp/opencode/sonnet55-gateway-"); gateways = []; });
afterEach(async () => { await Promise.all(gateways.map(g => g.close())); await rm(root, { recursive: true, force: true }); });
async function start(p = policy, upstream: GatewayUpstream = ok) {
  const gateway = await startGateway({ policy: p, ledgerRoot: root, token, mode: "live", upstream });
  gateways.push(gateway);
  return gateway;
}
const post = (address: string, value: unknown) => fetch(address + "/v1/messages", { method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
const receipt = async (address: string) => (await fetch(address + "/receipt", { headers: { authorization: `Bearer ${token}` } })).json();

describe("Sonnet 5.5 research gateway gate", () => {
  it("pins the new model/profile without changing historical Sonnet 5 validation", () => {
    expect(() => validateSpendPolicy(policy)).not.toThrow();
    expect(() => validateSpendPolicy({ ...policy, model: "claude-sonnet-5", pricing_profile: "reviewed-text-upper-rates-20260907-v1" })).not.toThrow();
    for (const change of [{ model: "claude-sonnet-5" }, { pricing_profile: "reviewed-text-upper-rates-20260907-v1" },
      { provider: "openai" }, { input_microusd_per_token: 2 }, { output_microusd_per_token: 9 }]) {
      expect(() => validateSpendPolicy({ ...policy, ...change })).toThrow();
    }
    expect(gatewayReservation(policy, 65536)).toBe(567296);
  });
  it("forwards explicit between_tools unchanged through the fixed Anthropic route", async () => {
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(JSON.parse(String(init.body))).toEqual(body());
      return ok(url, init);
    });
    const g = await start(policy, upstream);
    expect((await post(g.address, body())).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await receipt(g.address)).reservations).toBe(1);
  });
  it.each([undefined, { type: "disabled" }, { type: "adaptive" }, { type: "enabled", budget_tokens: 1024 },
    { type: "between_tools", display: "summarized" }])("denies unsupported thinking before spending: %j", async thinking => {
    const upstream = vi.fn(ok); const g = await start(policy, upstream);
    expect((await post(g.address, { ...body(), thinking })).status).toBe(400);
    expect((await receipt(g.address)).reservations).toBe(0); expect(upstream).not.toHaveBeenCalled();
  });
  it.each([
    { tools: [] }, { tool_choice: { type: "any" } }, { temperature: 0 }, { top_p: 1 }, { fallbacks: "default" },
    { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "fake" }] }] },
    { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "fake", name: "bash", input: {} }] }] },
  ])("denies unimplemented tool/replay/sampling/fallback paths before spending: %j", async change => {
    const upstream = vi.fn(ok); const g = await start(policy, upstream);
    expect((await post(g.address, { ...body(), ...change })).status).toBe(400);
    expect((await receipt(g.address)).reservations).toBe(0); expect(upstream).not.toHaveBeenCalled();
  });
  it("keeps failed calls charged and rejects replay across gateway restarts", async () => {
    const upstream = vi.fn(async () => Response.json({ error: { type: "rate_limit_error" } }, { status: 429 }));
    const first = await start(policy, upstream);
    expect((await post(first.address, body())).status).toBe(502);
    const before = await receipt(first.address);
    await first.close();
    gateways = gateways.filter(g => g !== first);
    const second = await start(policy, upstream);
    expect((await post(second.address, body())).status).toBe(400);
    expect((await receipt(second.address)).reserved_microusd).toBe(before.reserved_microusd);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("accepts a terminal refusal without retry or refund (stream=%s)", async stream => {
    const payload = stream ? [
      { type: "message_delta", delta: { stop_reason: "refusal" } }, { type: "message_stop" },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") :
      JSON.stringify({ type: "message", stop_reason: "refusal", content: [{ type: "text", text: "Declined." }] });
    const upstream = vi.fn(async () => new Response(payload, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }));
    const g = await start(policy, upstream);
    const response = await post(g.address, { ...body(), stream });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
    const state = await receipt(g.address);
    expect(state.process_counts.completed).toBe(1);
    expect(state.process_counts.failed).toBe(0);
    expect(state.reservations).toBe(1);
    expect(state.reserved_microusd).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("enforces a shared ten-dollar cap across concurrent gateways and restart", async () => {
    const upstream = vi.fn(ok);
    const a = await start(policy, upstream);
    const b = await start({ ...policy, run_id: "run-second" }, upstream);
    // Near-maximum admitted requests exhaust the conservative cap in a small
    // number of synthetic calls. No real credentials or network transport.
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all([a, b].map((g, index) => post(g.address, body(`${batch}-${index}:` + "x".repeat(64000)))));
    }
    const state = await receipt(a.address);
    expect(state.reserved_microusd).toBeLessThanOrEqual(10000000);
    expect(state.reserved_microusd).toBeGreaterThan(9400000);
    const count = upstream.mock.calls.length;
    await a.close(); await b.close();
    gateways = gateways.filter(g => g !== a && g !== b);
    const restarted = await start({ ...policy, run_id: "run-restarted" }, upstream);
    expect((await post(restarted.address, body("next:" + "x".repeat(64000)))).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(count);
    expect((await receipt(restarted.address)).reserved_microusd).toBe(state.reserved_microusd);
  });
  it.each(["max_tokens", "pause_turn", "model_context_window_exceeded", "private-provider-value", null])("retains safe stop diagnostics and rejects incomplete JSON: %s", async reason => {
    const g = await start(policy, async () => Response.json({ type: "message", stop_reason: reason, content: [{ type: "text", text: "private partial text" }] }));
    const response = await post(g.address, body());
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":"gateway_request_failed"}');
    const state = await receipt(g.address);
    expect(state.failure_diagnostics.records[0]).toMatchObject({ code: "response_incomplete", reserved: true,
      provider_stop_reason: reason === "private-provider-value" ? "unknown" : reason });
    expect(JSON.stringify(state)).not.toContain("private");
    expect(state.reservations).toBe(1);
  });
  it("does not allow an earlier SSE completion to mask a final token limit", async () => {
    const payload = [
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const g = await start(policy, async () => new Response(payload, { headers: { "content-type": "text/event-stream" } }));
    try { await (await post(g.address, { ...body(), stream: true })).text(); } catch { /* Stream closes on incomplete response. */ }
    const state = await receipt(g.address);
    expect(state.process_counts.completed).toBe(0);
    expect(state.failure_diagnostics.records[0]).toMatchObject({ provider_stop_reason: "max_tokens", code: "sse_missing_terminal" });
  });
});
