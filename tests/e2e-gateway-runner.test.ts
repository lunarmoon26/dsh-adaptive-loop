import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeSessionFrames, e2eRunStore, executionMode, gatewayLedgerRoot, gatewayPolicyTemplate, plannedRunId, safeGatewayReceipt, sessionObservation, transmissionManifest } from "../benchmarks/tau-style-workflow/run-e2e.js";
import { candidateDockerArgv, containerIsolationFacts, type ContainerInspection, gatewayDockerArgv, networkDockerArgv, topologyFor } from "../benchmarks/tau-style-workflow/e2e-topology.js";
import { buildGatewayCompositionPatch } from "../benchmarks/tau-style-workflow/e2e-prompt.js";
import { ingestRunRecord } from "../src/runs.js";
import { loadPolicy } from "../src/schema.js";

const args = () => new Map([["mode", "rehearsal"], ["campaign", "campaign-one"], ["batch", "batch-one"], ["provider", "openai"], ["model", "gpt-5.6-terra"], ["provider-cap-microusd", "6000000"]]);

describe("gateway runner preflight without credentials or containers", () => {
  it("requires explicit mode, cap and reviewed routes", () => {
    expect(() => executionMode(new Map())).toThrow("--mode");
    for (const cap of ["", "0", "-1", "1.5", "6e6", "9007199254740992"]) {
      const options = args(); options.set("provider-cap-microusd", cap);
      expect(() => gatewayPolicyTemplate(options, "run-one")).toThrow();
    }
    const options = args(); options.set("model", "gpt-5.6-luna");
    expect(() => gatewayPolicyTemplate(options, "run-one")).toThrow();
  });
  it("shares campaign budget across attempts and separates rehearsal from live", () => {
    const options = args();
    const one = gatewayPolicyTemplate(options, plannedRunId(options, "task.json", 1));
    const two = gatewayPolicyTemplate(options, plannedRunId(options, "task.json", 2));
    expect(one.run_id).not.toBe(two.run_id);
    expect(one.budget_id).toBe(two.budget_id);
    options.set("mode", "live"); options.set("approval-id", "dec-campaign-one");
    expect(gatewayPolicyTemplate(options, "run-live").budget_id).toBe("campaign-one");
    expect(one.budget_id).toBe("rehearsal-campaign-one");
  });
  it.each(["live", "rehearsal"])("allows only the canonical shared ledger in %s mode", async mode => {
    const options = args();
    options.set("mode", mode);
    const canonical = await gatewayLedgerRoot(options);
    expect(canonical).toMatch(/\/\.dal\/check\/spend$/);
    options.set("gateway-ledger", canonical);
    expect(await gatewayLedgerRoot(options)).toBe(canonical);
    for (const path of ["relative", "/tmp/different-ledger", `${canonical}/`, `${canonical}/../spend`, `${canonical}-new`]) {
      options.set("gateway-ledger", path);
      await expect(gatewayLedgerRoot(options)).rejects.toThrow("overrides are disabled");
    }
  });
  it("rejects rehearsal store overrides and invalid campaigns before image preparation", async () => {
    const options = args(); options.set("tasks", "task-001-refund.json");
    for (const store of [".dal/runs", await e2eRunStore(options), "/tmp/alternate-runs"]) {
      options.set("store", store);
      await expect(transmissionManifest(options)).rejects.toThrow("--store is disabled in rehearsal");
    }
    options.delete("store"); options.set("campaign", "../../runs");
    await expect(e2eRunStore(options)).rejects.toThrow("safe identifier");
  });
  it("ingests marked rehearsal records only into the campaign's isolated store", async () => {
    const options = args(); options.set("campaign", `test-${randomUUID()}`);
    const store = await e2eRunStore(options);
    const root = await realpath(join(import.meta.dirname, ".."));
    const policy = await loadPolicy();
    const ordinaryStore = join(root, policy.default_run_store);
    expect(store).toBe(join(root, ".dal/check/rehearsal-runs", options.get("campaign")!));
    expect(store).not.toBe(ordinaryStore);
    const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/runs/run-fixture-succeeded.json"), "utf8"));
    const record = { ...fixture, run_id: `run-test-${randomUUID()}`, evidence: ["dal-e2e-mode://rehearsal", `repo://.dal/check/e2e-gateways/run-test/rehearsal.json`] };
    try {
      await mkdir(join(store, "staged"), { recursive: true });
      const path = join(store, "staged", `${record.run_id}.json`);
      await writeFile(path, JSON.stringify(record), { flag: "wx" });
      const result = await ingestRunRecord(path, await e2eRunStore(options));
      expect(result.path).toBe(join(store, `${record.run_id}.json`));
      expect(result.record.evidence).toContain("dal-e2e-mode://rehearsal");
      await expect(access(join(ordinaryStore, `${record.run_id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      const live = new Map(options); live.set("mode", "live");
      expect(await e2eRunStore(live)).toBe(ordinaryStore);
    } finally { await rm(store, { recursive: true, force: true }); }
  });
  it("rejects an isolated-store symlink alias to the ordinary store", async () => {
    const options = args(); options.set("campaign", `test-link-${randomUUID()}`);
    const path = await e2eRunStore(options);
    await mkdir(dirname(path), { recursive: true });
    await symlink(join(await realpath(join(import.meta.dirname, "..")), ".dal/runs"), path);
    try { await expect(e2eRunStore(options)).rejects.toThrow("real directories"); }
    finally { await rm(path); }
  });
  it.each(["rehearsal", "live"] as const)("confines %s candidates and scopes gateway credentials", mode => {
    const topology = topologyFor("unique-attempt");
    const networks = networkDockerArgv(topology, mode);
    expect(networks.filter(argv => argv.includes("--internal"))).toHaveLength(2);
    expect(networks).toHaveLength(mode === "live" ? 3 : 2);
    const gateway = gatewayDockerArgv({ image: "sha256:pinned", topology, mode, provider: "openai", policyPath: "/policy", ledgerRoot: "/ledger" });
    expect(gateway.includes("OPENAI_API_KEY")).toBe(mode === "live");
    expect(gateway).not.toContain("ANTHROPIC_API_KEY");
    const candidate = candidateDockerArgv({ image: "sha256:pinned", topology, stageRoot: "/stage", dshHomeHost: "/home", keyEnv: "OPENAI_API_KEY", prompt: "work" });
    expect(candidate).toContain("DAL_GATEWAY_TOKEN");
    expect(candidate).toContain("--expose-internals");
    expect(candidate).toContain("--import");
    expect(candidate).toContain("/opt/dal/dist/e2e-openai-text-replay-preload.js");
    expect(candidate).toContain("/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
    expect(candidate.join(" ")).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|docker.sock|network host|gateway-ledger/);
    expect(candidate).not.toContain(topology.outboundNetwork);
  });
  it.each([["openai", "gpt-5.6-terra", "/v1", "openai-responses"], ["anthropic", "claude-sonnet-5", "", "anthropic-messages"]])("pins %s native protocol and output bounds", (provider, model, suffix, api) => {
    const patch = buildGatewayCompositionPatch(provider!, model!, "http://service");
    expect(patch).toContain(`baseURL: http://dal-model-gateway:8787${suffix}\n`);
    expect(patch).toContain(`api: ${api}`);
    expect(patch).toContain("maxTokens: 1024");
    expect(patch).toContain("contextWindow: 139000");
    expect(patch).toContain("maxRetries: 0");
    expect(patch).toContain("apiKeyEnv: DAL_GATEWAY_TOKEN");
    if (provider === "anthropic") {
      expect(patch).toContain("reasoning: off");
      expect(patch).not.toContain("reasoningEfforts: false");
    } else {
      expect(patch).toContain("reasoningEfforts: false");
      expect(patch).not.toContain("reasoning: off");
    }
    expect(patch).not.toContain("reasoning: false");
    expect(patch).toContain("- id: session-title-llm\n  disabled: true");
    expect(patch).toContain("- insert:\n    - id: dal-workflow-tools");
    expect(patch).toContain("name: '/opt/dal/plugins/dal-workflow-tools/lib/index.js'");
    expect(patch).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  });
  it("projects only safe receipt counters, retaining reservations rather than claiming zero billing", () => {
    const policy = gatewayPolicyTemplate(args(), "run-one");
    const value = { campaign_id: policy.campaign_id, run_id: policy.run_id, provider: policy.provider, mode: "rehearsal", reservations: 2, reserved_microusd: 123456, process_counts: { completed: 2, failed: 0, rejected: 0, response_bytes: 100 }, accounting: "upper-bound-reservations-no-refund", unexpected: "not persisted" };
    expect(safeGatewayReceipt(value, policy, "rehearsal")).not.toHaveProperty("unexpected");
    expect(safeGatewayReceipt(value, policy, "rehearsal").reserved_microusd).toBe(123456);
    expect(() => safeGatewayReceipt({ ...value, run_id: "other" }, policy, "rehearsal")).toThrow();
    expect(() => safeGatewayReceipt({ ...value, reserved_microusd: 6000001 }, policy, "rehearsal")).toThrow();
    const failure = { stage: "upstream", code: "http_rejected", reserved: true, upstream_status: 401, provider_error_type: "authentication_error", provider_error_code: null };
    const diagnostics = { records: [failure], dropped_count: 0 };
    expect(safeGatewayReceipt({ ...value, failure_diagnostics: diagnostics }, policy, "rehearsal").failure_diagnostics).toEqual(diagnostics);
    for (const bad of [
      { records: [failure], dropped_count: -1 },
      { records: Array(33).fill(failure), dropped_count: 0 },
      { records: [{ ...failure, message: "private reply" }], dropped_count: 0 },
      { records: [{ ...failure, provider_error_type: "arbitrary-private-text" }], dropped_count: 0 },
      { records: [failure], dropped_count: 0, payload: "private" },
      null,
    ]) expect(() => safeGatewayReceipt({ ...value, failure_diagnostics: bad }, policy, "rehearsal")).toThrow();
  });
  it("requires an observed tool call before DONE and projects real usage counters only", () => {
    const events = [
      { type: "tool/call", data: { name: "get_order", callId: "call-one", arguments: "not retained" } },
      { type: "tool/result", data: { message: { source: { callId: "call-one" } } } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "DONE" }] }, usage: { inputTokens: 30, outputTokens: 4 } } },
    ];
    expect(sessionObservation(events.map(event => JSON.stringify(event)).join("\n"))).toEqual({ tool_calls: 1, input_tokens: 30, output_tokens: 4, get_order_succeeded: true, get_order_then_done: true });
    expect(sessionObservation(JSON.stringify(events[2])).get_order_then_done).toBe(false);
    expect(sessionObservation([events[0], { ...events[1], data: { ...events[1]!.data, error: { code: "UNKNOWN_TOOL" } } }, events[2]].map(event => JSON.stringify(event)).join("\n")).get_order_then_done).toBe(false);
    expect(sessionObservation("")).not.toHaveProperty("input_tokens");
  });
  it("decodes all independent DSH frames and rejects truncated or corrupt tails", () => {
    const chunks = ['{"type":"session"}\n', '{"type":"tool/call","data":{"name":"get_order","callId":"call-one"}}\n'];
    const encoded = Buffer.concat(chunks.map(chunk => zstdCompressSync(Buffer.from(chunk))));
    expect(decodeSessionFrames(encoded)).toBe(chunks.join(""));
    expect(sessionObservation(decodeSessionFrames(encoded)).tool_calls).toBe(1);
    expect(() => decodeSessionFrames(encoded.subarray(0, -2))).toThrow();
    expect(() => decodeSessionFrames(Buffer.concat([encoded, Buffer.from("invalid")]))).toThrow();
  });
  it("verifies daemon-observed isolation without retaining capability values", () => {
    const info: ContainerInspection = {
      Image: "sha256:pinned", Config: { Env: ["DAL_GATEWAY_TOKEN=not-retained"] },
      HostConfig: { NetworkMode: "internal", ReadonlyRootfs: true, Privileged: false, PidMode: "", IpcMode: "private", CapAdd: null, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PortBindings: {}, ExtraHosts: null, Devices: [] },
      NetworkSettings: { Networks: { internal: {} } }, Mounts: [{ Type: "bind", Source: "/stage", Destination: "/workspace", RW: false }],
    };
    const expected = { image: info.Image, networks: ["internal"], envNames: ["DAL_GATEWAY_TOKEN"], mounts: [{ source: "/stage", destination: "/workspace", writable: false }] };
    const facts = containerIsolationFacts(info, expected);
    expect(facts.confinement_verified).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("not-retained");
    for (const mutate of [
      (v: ContainerInspection) => { v.Config.Env.push("OPENAI_API_KEY=forbidden"); },
      (v: ContainerInspection) => { v.NetworkSettings.Networks.outbound = {}; },
      (v: ContainerInspection) => { v.HostConfig.NetworkMode = "host"; },
      (v: ContainerInspection) => { v.HostConfig.CapAdd = ["NET_ADMIN"]; },
      (v: ContainerInspection) => { v.HostConfig.ReadonlyRootfs = false; },
      (v: ContainerInspection) => { v.Mounts[0]!.Source = "/var/run/docker.sock"; },
      (v: ContainerInspection) => { v.Mounts[0]!.Destination = "/gateway-ledger"; },
      (v: ContainerInspection) => { v.Mounts[0]!.RW = true; },
      (v: ContainerInspection) => { v.Image = "sha256:other"; },
    ]) {
      const changed = structuredClone(info); mutate(changed);
      expect(() => containerIsolationFacts(changed, expected)).toThrow("isolation");
    }
  });
});
