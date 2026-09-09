import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMeteredArguments, prepareMeteredProposal, runMeteredProposal, verifyMeteredProposal } from "../benchmarks/tau-style-workflow/run-metered-proposal.js";
import { gatewayPolicyTemplate } from "../benchmarks/tau-style-workflow/run-e2e.js";
import { clusterRunRecords } from "../src/clustering.js";
import { createRehearsalUpstream, gatewayReservation } from "../src/e2e-model-gateway.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { reserveProposalBudget } from "../src/proposal-budget.js";
import { ingestRunRecord } from "../src/runs.js";
import { assertSchema, SCHEMA_IDS } from "../src/schema.js";

const repo = resolve(import.meta.dirname, "..");
const ledgerRoot = join(repo, ".dal/check/spend");
let directory: string;
let campaign: string;
let args: Map<string, string>;
const network = globalThis.fetch;
let external: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "dal-metered-")));
  campaign = `test-metered-${randomUUID()}`;
  const runs = join(directory, "runs");
  const clusters = join(directory, "clusters");
  await ingestRunRecord(join(repo, "benchmarks/tau-style-workflow/dal/fixtures/run-benchmark-fail.json"), runs);
  await clusterRunRecords({ store: runs, output: clusters });
  args = new Map(Object.entries({ mode: "rehearsal", campaign, batch: "proposal-one", provider: "openai", model: "gpt-5.6-terra",
    "provider-cap-microusd": "1000000", clusters, runs, output: join(directory, "draft.json"),
    manifest: join(directory, "manifest.json"), "approval-id": "dec-metered-test" }));
  external = vi.fn(async () => { throw new Error("External network forbidden"); });
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("http://127.0.0.1:")) return network(url, init);
    return external(url, init);
  });
  vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("ANTHROPIC_API_KEY", undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
  // Remove only these tests' unique ledger entries and matching outcome sidecars.
  for (const budget of [campaign, `rehearsal-${campaign}`]) {
    for (const provider of ["openai", "anthropic"]) {
      const entries = join(ledgerRoot, budget, provider, "reservations");
      for (const name of await readdir(entries).catch(() => [])) {
        const record = JSON.parse(await readFile(join(entries, name), "utf8"));
        await rm(join(ledgerRoot, "gateway-outcomes", `${sha256(`${budget}:${provider}:${record.request_digest}`)}.json`), { force: true });
      }
    }
    await rm(join(ledgerRoot, budget), { recursive: true, force: true });
  }
});

async function prepare() {
  await runMeteredProposal(new Map([...args, ["prepare", "true"]]));
  return prepareMeteredProposal(args);
}
async function approve(digest: string, changes: Record<string, unknown> = {}) {
  const path = join(directory, "approval.json");
  await writeFile(path, JSON.stringify({
    $schema: SCHEMA_IDS.approval, schema_version: "1.0.0", decision_id: args.get("approval-id"), request_id: "req-metered-test",
    action: "send_data_externally", scope: { kind: "data_transfer", value: digest, sha256: sha256(digest) }, decision: "approved",
    reviewer: { kind: "human", id: "offline-reviewer" }, decided_at: new Date(Date.now() - 60000).toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), rationale: "Synthetic approval for local tests only.",
    evidence: ["repo://tests/metered-proposal.test.ts"], candidate_sha256: null, ...changes,
  }));
  args.set("approval", path);
}
async function reservations(budget = `rehearsal-${campaign}`) {
  const path = join(ledgerRoot, budget, args.get("provider")!, "reservations");
  return Promise.all((await readdir(path)).map(async name => JSON.parse(await readFile(join(path, name), "utf8"))));
}
function watchKeys() {
  const env = process.env;
  const reads = vi.fn();
  vi.stubGlobal("process", new Proxy(process, { get(target, key) {
    if (key !== "env") return Reflect.get(target, key);
    return new Proxy(env, { get(target, name) {
      if (typeof name === "string" && name.endsWith("_API_KEY")) reads(name);
      return Reflect.get(target, name);
    } });
  } }));
  return reads;
}

describe("metered proposal shared gateway handoff", () => {
  it.each([["openai", "gpt-5.6-terra"], ["anthropic", "claude-sonnet-5"]])("rehearses %s clusters to a validated draft through real local HTTP", async (provider, model) => {
    args.set("provider", provider); args.set("model", model);
    args.set("approval", join(directory, "must-not-be-read.json"));
    const keys = watchKeys();
    const { manifest, digest } = await prepare();
    expect((await prepareMeteredProposal(args)).digest).toBe(digest);
    expect(manifest.gateway_ledger_root).toBe(ledgerRoot);
    expect(manifest.gateway_policy).toEqual(gatewayPolicyTemplate(args, manifest.gateway_policy.run_id));
    expect(manifest.native_body).toMatchObject({ model, stream: false, [provider === "openai" ? "max_output_tokens" : "max_tokens"]: 1024 });
    expect(manifest.native_body).not.toHaveProperty("tools");
    expect(manifest).not.toHaveProperty("budget");
    await expect(runMeteredProposal(new Map([...args, ["verify", "true"]]))).resolves.toMatchObject({ status: "verified" });
    await expect(runMeteredProposal(args)).resolves.toMatchObject({ status: "recorded", mode: "rehearsal" });
    const draft = JSON.parse(await readFile(args.get("output")!, "utf8"));
    await assertSchema(SCHEMA_IDS.proposalDraft, draft, "Rehearsal draft");
    expect(draft).toMatchObject({ payload_sha256: manifest.payload_sha256, provenance: { runner: `${provider}-https`, request_sha256: digest } });
    const receipt = JSON.parse(await readFile(`${args.get("output")}.gateway-receipt.json`, "utf8"));
    expect(receipt).toMatchObject({ mode: "rehearsal", execution_attestation: false, draft_validated: true, reservations: 1,
      process_counts: { completed: 1, failed: 0 }, reserved_microusd: gatewayReservation(manifest.gateway_policy, Buffer.byteLength(canonicalJson(manifest.native_body))) });
    const before = await reservations();
    args.set("output", join(directory, "repeat.json"));
    await expect(runMeteredProposal(args)).rejects.toThrow("broker rejected");
    expect(await reservations()).toEqual(before);
    expect(keys).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong-id", "expired", "denied", "wrong-digest"])("denies %s live approval before listener, credentials, or network", async kind => {
    args.set("mode", "live");
    const { digest } = await prepare();
    if (kind !== "missing") await approve(kind === "wrong-digest" ? "a".repeat(64) : digest,
      kind === "wrong-id" ? { decision_id: "dec-another-id" } : kind === "expired" ? { decided_at: "2020-01-01T00:00:00Z", expires_at: "2020-01-02T00:00:00Z" } : kind === "denied" ? { decision: "rejected" } : {});
    const keys = watchKeys();
    const calls = vi.spyOn(globalThis, "fetch");
    await expect(runMeteredProposal(args)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    await expect(readdir(join(ledgerRoot, campaign))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["payload", "provider", "model", "rates", "digest", "extra", "cap", "source"])("denies approved %s drift without network", async kind => {
    args.set("mode", "live");
    const { digest, manifest } = await prepare(); await approve(digest);
    if (kind === "payload") manifest.payload.clusters[0]!.member_count++;
    if (kind === "rates") manifest.gateway_policy.input_microusd_per_token = 4;
    if (kind === "source") manifest.driver_sources[0]!.sha256 = "0".repeat(64);
    if (kind === "extra") Object.assign(manifest, { bypass: true });
    if (["payload", "rates", "source", "extra"].includes(kind)) await writeFile(args.get("manifest")!, canonicalJson(manifest));
    if (kind === "provider") { args.set("provider", "anthropic"); args.set("model", "claude-sonnet-5"); }
    if (kind === "model") args.set("model", "gpt-other");
    if (kind === "cap") args.set("provider-cap-microusd", "2000000");
    if (kind === "digest") await writeFile(`${args.get("manifest")}.sha256`, `${"0".repeat(64)}\n`);
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(runMeteredProposal(args)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
  });

  it("rechecks changed source clusters rather than sending stored payload", async () => {
    await prepare();
    const dir = args.get("clusters")!;
    const name = (await readdir(dir))[0]!;
    const path = join(dir, name); const value = JSON.parse(await readFile(path, "utf8"));
    value.fingerprint.code = "changed-code"; await writeFile(path, JSON.stringify(value));
    await expect(verifyMeteredProposal(args)).rejects.toThrow();
    expect(external).not.toHaveBeenCalled();
  });

  it("cannot bypass a prior rollout reservation or change its campaign provider cap", async () => {
    args.set("mode", "live");
    const { manifest, digest } = await prepare(); await approve(digest);
    await reserveProposalBudget({ store: ledgerRoot, provider: "openai", requestDigest: sha256("prior-rollout-body"), approvalId: "dec-prior-rollout",
      budget: { budget_id: campaign, provider_limit_microusd: 1000000, reservation_microusd: 1000000 - manifest.reservation_upper_microusd + 1 } });
    const before = await reservations(campaign); const keys = watchKeys();
    await expect(runMeteredProposal(args)).rejects.toThrow("broker rejected");
    expect(await reservations(campaign)).toEqual(before); expect(keys).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
    args.set("provider-cap-microusd", "2000000"); args.set("manifest", join(directory, "larger.json")); args.set("output", join(directory, "larger-draft.json"));
    const next = await prepare(); await approve(next.digest);
    await expect(runMeteredProposal(args)).rejects.toThrow("broker rejected");
    expect(await reservations(campaign)).toEqual(before); expect(keys).not.toHaveBeenCalled();
  });

  it.each(["valid", "invalid-json", "refusal", "incomplete", "missing-key"])("retains exact reservation after %s native live mock response", async kind => {
    args.set("mode", "live");
    const { manifest, digest } = await prepare(); await approve(digest);
    if (kind !== "missing-key") vi.stubEnv("OPENAI_API_KEY", "offline-test-key");
    const fixture = createRehearsalUpstream();
    external.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(JSON.parse(String(init.body))).toEqual(manifest.native_body);
      expect(await reservations(campaign)).toMatchObject([{ reservation_microusd: manifest.reservation_upper_microusd }]);
      if (kind === "valid") return fixture(url, init);
      return Response.json({ status: kind === "incomplete" ? "incomplete" : "completed", output: [{ type: "message", status: "completed", role: "assistant",
        content: kind === "refusal" ? [{ type: "refusal", refusal: "Cannot comply" }] : [{ type: "output_text", text: "not JSON" }] }] });
    });
    if (kind === "valid") await expect(runMeteredProposal(args)).resolves.toMatchObject({ status: "recorded" });
    else {
      await expect(runMeteredProposal(args)).rejects.toThrow();
      await expect(readFile(args.get("output")!)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const before = await reservations(campaign); expect(before).toHaveLength(1);
    args.set("output", join(directory, "retry.json"));
    await expect(runMeteredProposal(args)).rejects.toThrow("broker rejected");
    expect(await reservations(campaign)).toEqual(before);
    expect(external).toHaveBeenCalledTimes(kind === "missing-key" ? 0 : 1);
  });

  it("rejects endpoint, budget-root, duplicate, and malformed flag overrides", async () => {
    for (const option of ["--endpoint", "--gateway-ledger", "--budget", "--runner", "--env-file"]) expect(() => parseMeteredArguments([option, "other"])).toThrow();
    expect(() => parseMeteredArguments(["--mode", "live", "--mode", "rehearsal"])).toThrow();
    expect(() => parseMeteredArguments(["--prepare"])).toThrow();
    await expect(prepareMeteredProposal(new Map([...args, ["prepare", "false"]]))).rejects.toThrow();
    await expect(prepareMeteredProposal(new Map([...args, ["campaign", "rehearsal-other"]]))).rejects.toThrow("reserved rehearsal namespace");
  });
});
