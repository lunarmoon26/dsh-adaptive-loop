import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import type { OptimizerExchange } from "../src/types.js";
import { assessDevelopmentBaseline, DEVELOPMENT_TASKS, FAULT_PROFILES } from "../benchmarks/tau-style-workflow/skill-adaptation.js";
import type { E2eSummary } from "../benchmarks/tau-style-workflow/e2e-summary.js";

const repo = resolve(import.meta.dirname, "..");
const ledgerRoot = join(repo, ".dal/check/spend");
let directory: string;
let campaign: string;
let args: Map<string, string>;
const network = globalThis.fetch;
let external: ReturnType<typeof vi.fn>;
let skillDirectory: string | undefined;
let candidateOut: string | undefined;
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
  if (skillDirectory) await rm(skillDirectory, { recursive: true, force: true });
  if (candidateOut) await rm(candidateOut, { force: true });
  skillDirectory = undefined; candidateOut = undefined;
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

  // Synthetic, digest-bound validator evidence only, not a real baseline or model result.
  async function baselineFixture(baseDigest: string, options: { passed?: boolean; task?: string; mode?: string; provider?: string; model?: string; candidate?: string; faults?: string; resolutions?: string } = {}) {
    const prefix = skillDirectory!.slice(repo.length + 1);
    const task = options.task ?? DEVELOPMENT_TASKS[0];
    const model = { provider: options.provider ?? args.get("provider")!, model: options.model ?? args.get("model")! };
    const candidate = options.candidate ?? baseDigest;
    const passed = options.passed ?? false;
    const manifest = { mode: options.mode ?? "live", ...model, generation: "g0", attempts_per_task: 1, runner: "docker",
      faults: options.faults ?? FAULT_PROFILES.development.faults, resolutions: options.resolutions ?? FAULT_PROFILES.development.resolutions,
      skill_sha256: candidate, benchmark_context_sha256: "b".repeat(64), container_image_sha256: "3".repeat(64), evaluator_tasks: [{ task_id: task, sha256: sha256(task) }] };
    const manifestPath = `${prefix}/baseline-manifest.json`;
    await writeFile(join(repo, manifestPath), JSON.stringify(manifest));
    const manifestDigest = sha256(canonicalJson(manifest));
    const receiptPath = `${prefix}/baseline-receipt.json`;
    const runPath = `${prefix}/baseline-runs/run.json`;
    const source = "repo://tests/metered-proposal.test.ts";
    const business = { status: passed ? "passed" : "failed", source, score: Number(passed), earned: Number(passed), total: 1 };
    const runId = "run-synthetic-metered-baseline";
    const receipt = { $schema: SCHEMA_IDS.executionReceipt, schema_version: "1.0.0", receipt_id: "rcp-synthetic-metered-baseline", run_id: runId,
      created_at: "2026-09-10T00:00:00.000Z", candidate_sha256: candidate, base_generation_id: "g0", candidate_generation_id: "g0",
      effective_composition_sha256: "d".repeat(64), task_handle: task, model, model_patch_sha256: "e".repeat(64), dsh_session_id: null, event_log_head_sha256: null,
      container_image_sha256: manifest.container_image_sha256, transmission_manifest_sha256: manifestDigest,
      external_state_before_sha256: "0".repeat(64), external_state_after_sha256: "a".repeat(64), grader_receipt_sha256: "1".repeat(64), source,
      isolation: { topology: "candidate-service-grader-v1", candidate_workspace_sha256: "2".repeat(64), candidate_workspace_read_only: true,
        candidate_repository_mounted: false, service_state_access: "typed-endpoint-only", oracle_access: "grader-only" }, business_outcome: business };
    const run = { $schema: SCHEMA_IDS.runRecord, schema_version: "1.0.0", run_id: runId, task_id: task, change_id: "chg-dal-skill-adaptation-slice-20260910",
      started_at: "2026-09-10T00:00:00.000Z", finished_at: "2026-09-10T00:01:00.000Z", outcome: "succeeded", failure: null,
      context: { task_set: "tau-style-workflow-e2e", environment_snapshot: "Synthetic validator fixture only", tool_versions: [],
        model: { id: model.model, version: model.provider }, prompt_sha256: null, harness_sha256: null, grader_version: "2.0.0", seeds: [], context_policy_sha256: null,
        inference_parameters: [], harness_pins: [{ surface: "skills", uri: "repo://synthetic-skill", sha256: candidate }] },
      artifacts: [], checks: passed ? [] : [{ id: "business-verdict", pass: false, detail: "Synthetic development failure", goal_sha256: "7".repeat(64), actual_sha256: "a".repeat(64) }],
      business_outcome: business, metrics: { duration_ms: 1, tool_calls: 0 }, evidence: [`repo://${receiptPath}`],
      privacy: { classification: "internal", contains_personal_data: false, redactions: [] } };
    const receiptRaw = JSON.stringify(receipt), runRaw = JSON.stringify(run);
    await mkdir(join(skillDirectory!, "baseline-runs"), { recursive: true });
    await writeFile(join(repo, receiptPath), receiptRaw); await writeFile(join(repo, runPath), runRaw);
    const summary: E2eSummary = { format: "e2e-summary-v1", summary_id: "esm-synthetic-metered", created_at: "2026-09-10T00:02:00.000Z", batch: "synthetic-baseline",
      task_set: [task], model, generation: "g0", candidate_sha256: candidate, benchmark_context_sha256: manifest.benchmark_context_sha256,
      transmission_manifest_path: manifestPath, transmission_manifest_sha256: manifestDigest, runner: "docker", faults: manifest.faults, resolutions: manifest.resolutions,
      attempts_per_task: 1, per_task: [{ task_id: task, attempts: 1, passed: Number(passed), mean: Number(passed), pass_at_1: passed, checkpoint_pass: passed,
        attempts_detail: [{ attempt: 1, run_id: runId, run_record_path: runPath, run_record_sha256: sha256(runRaw), receipt_path: receiptPath, receipt_sha256: sha256(receiptRaw), state_sha256: "a".repeat(64), passed }] }],
      overall: { mean_success_rate: Number(passed), pass_at_1: Number(passed), checkpoint_rate: Number(passed), variance: 0 } };
    const path = join(skillDirectory!, "baseline-summary.json");
    await writeFile(path, JSON.stringify(summary));
    args.set("development-baseline", path); args.set("runs", join(skillDirectory!, "baseline-runs"));
    return { path, summary, run, receipt };
  }

  async function skillFixture() {
    skillDirectory = await mkdtemp(join(repo, ".dal/check/skill-proposal-test-"));
    const skillPath = join(skillDirectory, ".agents/skills/refund/SKILL.md");
    await mkdir(join(skillDirectory, ".agents/skills/refund"), { recursive: true });
    await mkdir(join(repo, ".dal/candidates"), { recursive: true });
    const base = "\ufeff# Refund skill\r\nCheck refund status.\r\n";
    await writeFile(skillPath, base);
    const exchange: OptimizerExchange = { $schema: SCHEMA_IDS.optimizer, schema_version: "1.0.0", exchange_id: "opt-metered-skill", mode: "prepare_only", provider_hint: "skillopt",
      target: { kind: "skill", artifact_uri: `repo://${skillPath.slice(repo.length + 1)}`, base_sha256: sha256(Buffer.from(base)), format: "bounded_edits" },
      objective: { goal: "Improve recovery", metrics: ["task_success_rate"], higher_is_better: true },
      datasets: { train: ["repo://never-read-training.json"], validation: ["repo://never-read-evaluator.json"], test: ["repo://never-read-holdout.json"] },
      budget: { max_candidates: 1, max_evaluations: 1, max_wall_time_seconds: 30, max_external_cost_usd: 0 },
      privacy: { classification: "internal", external_transfer_approved: false, approval_ref: null }, result: null };
    const exchangePath = join(skillDirectory, "exchange.json");
    await writeFile(exchangePath, JSON.stringify(exchange));
    args.set("exchange", exchangePath);
    args.set("candidate-out", `.dal/candidates/${campaign}.md`);
    candidateOut = join(repo, args.get("candidate-out")!);
    const candidate = { $schema: SCHEMA_IDS.optimizerCandidate, schema_version: "1.0.0", candidate_id: "cand-metered-skill", exchange_id: exchange.exchange_id,
      surface: "skills", target_uri: exchange.target.artifact_uri, base_sha256: exchange.target.base_sha256,
      title: "Recover unknown refunds", objective: "Improve recovery", statement: "Recovery success increases without duplicate refunds.",
      improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }], regressions: [],
      edits: [{ anchor: "status", before: "Check refund status.", after: "Check refund status before retrying. Preserve caf\u00e9 notes." }] };
    await baselineFixture(exchange.target.base_sha256);
    args.set("clusters", join(skillDirectory, "baseline-clusters"));
    await clusterRunRecords({ store: args.get("runs")!, output: args.get("clusters")! });
    return { base, skillPath, candidate, exchange };
  }

  it.each(["valid", "valid-anthropic", "missing-anchor", "no-change", "wrong-exchange", "wrong-base", "wrong-target", "wrong-surface", "malformed", "extra-model", "base-drift", "baseline-drift"])("skill mode gates %s through a real gateway with a mocked native upstream", async kind => {
    if (kind === "valid-anthropic") { args.set("provider", "anthropic"); args.set("model", "claude-sonnet-5"); }
    const { base, skillPath, candidate } = await skillFixture();
    args.set("mode", "live");
    if (kind === "valid-anthropic") { args.set("provider", "anthropic"); args.set("model", "claude-sonnet-5"); }
    const { manifest, digest } = await prepare(); await approve(digest);
    expect(manifest.driver_sources.map(source => source.path)).toEqual(expect.arrayContaining(["src/skill-proposal.ts", "src/optimizer-adapter.ts", "src/optimizer.ts"]));
    expect(manifest.driver_sources.map(source => source.path)).toEqual(expect.arrayContaining(["benchmarks/tau-style-workflow/skill-adaptation.ts", "benchmarks/tau-style-workflow/e2e-summary.ts"]));
    expect(await assessDevelopmentBaseline(args.get("development-baseline")!, repo)).toMatchObject({ eligible: true });
    expect(manifest.inputs.development_baseline).toMatchObject({ path: args.get("development-baseline"), sha256: sha256(await readFile(args.get("development-baseline")!)),
      evidence: [expect.objectContaining({ attempts: [expect.objectContaining({ task_id: DEVELOPMENT_TASKS[0] })] })] });
    expect(canonicalJson(manifest.native_body)).not.toContain("baseline-summary.json");
    expect(canonicalJson(manifest.native_body)).not.toContain("baseline-receipt.json");
    expect(manifest.skill_proposal?.base.sha256).toBe(sha256(Buffer.from(base)));
    if (kind === "missing-anchor") candidate.edits[0]!.before = "missing anchor";
    if (kind === "no-change") candidate.edits[0]!.after = candidate.edits[0]!.before;
    if (kind === "wrong-exchange") candidate.exchange_id = "opt-wrong";
    if (kind === "wrong-base") candidate.base_sha256 = "0".repeat(64);
    if (kind === "wrong-target") candidate.target_uri = "repo://tests/fixture.md";
    if (kind === "wrong-surface") candidate.surface = "prompt";
    if (kind === "extra-model") Object.assign(candidate, { model: "invented-model" });
    vi.stubEnv("OPENAI_API_KEY", "offline-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");
    external.mockImplementation(async (_url: string, init: RequestInit) => {
      const request = String(init.body);
      expect(JSON.parse(request)).toEqual(manifest.native_body);
      for (const marker of ["never-read-training", "never-read-evaluator", "never-read-holdout"]) expect(request).not.toContain(marker);
      expect(await reservations(campaign)).toHaveLength(1);
      if (kind === "base-drift") await writeFile(skillPath, base + "changed during response");
      if (kind === "baseline-drift") await writeFile(args.get("development-baseline")!, (await readFile(args.get("development-baseline")!, "utf8")) + "\n");
      if (kind === "valid-anthropic") return Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(candidate) }] });
      return Response.json({ status: "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: kind === "malformed" ? "not JSON" : JSON.stringify(candidate) }] }] });
    });
    if (kind === "valid" || kind === "valid-anthropic") {
      const result = await runMeteredProposal(args);
      const expected = Buffer.from(base.replace(candidate.edits[0]!.before, candidate.edits[0]!.after));
      expect(await readFile(candidateOut!)).toEqual(expected);
      expect(result).toMatchObject({ candidate_path: candidateOut, candidate_sha256: sha256(expected) });
      expect(JSON.parse(await readFile(args.get("output")!, "utf8"))).toEqual(candidate);
      const verdict = JSON.parse(await readFile(`${args.get("output")}.optimizer-verdict.json`, "utf8"));
      expect(verdict).toMatchObject({ verdict: "valid", candidate_sha256: sha256(expected) });
      expect(verdict).not.toHaveProperty("base_text");
    } else {
      await expect(runMeteredProposal(args)).rejects.toThrow();
      await expect(readFile(candidateOut!)).rejects.toMatchObject({ code: "ENOENT" });
      if (!["missing-anchor", "no-change"].includes(kind)) await expect(readFile(args.get("output")!)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(JSON.parse(await readFile(`${args.get("output")}.optimizer-verdict.json`, "utf8"))).toMatchObject({ verdict: "invalid",
        checks: expect.arrayContaining([expect.objectContaining({ id: kind === "no-change" ? "changed" : "anchors", pass: false })]) });
    }
    if (kind !== "base-drift") expect(await readFile(skillPath, "utf8")).toBe(base);
    expect(external).toHaveBeenCalledTimes(1);
    expect(await reservations(campaign)).toHaveLength(1);
  });

  it.each(["base", "exchange", "candidate-out", "source", "approval"])("skill mode rejects %s drift or missing authority before gateway startup", async kind => {
    const { base, skillPath } = await skillFixture();
    args.set("mode", "live");
    const { manifest, digest } = await prepare();
    if (kind !== "approval") await approve(digest);
    if (kind === "base") await writeFile(skillPath, base + "drift");
    if (kind === "exchange") await writeFile(args.get("exchange")!, (await readFile(args.get("exchange")!, "utf8")) + "\n");
    if (kind === "candidate-out") args.set("candidate-out", `.dal/candidates/${campaign}-other.md`);
    if (kind === "source") { manifest.driver_sources.find(source => source.path === "src/skill-proposal.ts")!.sha256 = "0".repeat(64); await writeFile(args.get("manifest")!, canonicalJson(manifest)); }
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(runMeteredProposal(args)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    await expect(readFile(candidateOut!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(args.get("output")!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires paired skill flags and confines the destination before preparation", async () => {
    await skillFixture();
    for (const path of ["SKILL.md", ".dal/candidates/../baseline.md", ".dal/candidates/nested/review.md", ".dal/candidates/review.json"]) {
      await expect(prepareMeteredProposal(new Map([...args, ["candidate-out", path]]))).rejects.toThrow();
    }
    args.delete("candidate-out");
    await expect(prepareMeteredProposal(args)).rejects.toThrow("both");
  });

  it.each(["json", "markdown", "verdict", "staging-alias"])("rejects %s output conflicts before paid authority is used", async kind => {
    await skillFixture();
    args.set("mode", "live");
    const { digest } = await prepare(); await approve(digest);
    const existing = kind === "json" ? args.get("output")! : kind === "markdown" ? candidateOut! : `${args.get("output")}.optimizer-verdict.json`;
    if (kind === "staging-alias") args.set("output", candidateOut!);
    else await writeFile(existing, "prior artifact\n");
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(runMeteredProposal(args)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    if (kind !== "staging-alias") expect(await readFile(existing, "utf8")).toBe("prior artifact\n");
  });

  it.each(["missing-baseline", "missing-runs", "passed", "rehearsal", "wrong-task", "wrong-fault", "wrong-resolution", "wrong-provider", "wrong-model", "wrong-base", "state-only", "extra-run", "extra-cluster", "changed-run"])("live skill preparation rejects %s scientific evidence without a broker", async kind => {
    const { exchange } = await skillFixture(); args.set("mode", "live");
    if (kind === "missing-baseline") args.delete("development-baseline");
    if (kind === "missing-runs") args.delete("runs");
    const overrides = kind === "passed" ? { passed: true } : kind === "rehearsal" ? { mode: "rehearsal" }
      : kind === "wrong-task" ? { task: "task-001-refund.json" } : kind === "wrong-fault" ? { faults: "issue_refund=definite_failure" }
      : kind === "wrong-resolution" ? { resolutions: "issue_refund=definite_failure" } : kind === "wrong-provider" ? { provider: "anthropic" }
      : kind === "wrong-model" ? { model: "other-model" } : kind === "wrong-base" ? { candidate: "0".repeat(64) } : null;
    if (overrides) await baselineFixture(exchange.target.base_sha256, overrides);
    if (kind === "state-only") await rm(join(skillDirectory!, "baseline-receipt.json"));
    if (kind === "extra-run") {
      const run = JSON.parse(await readFile(join(args.get("runs")!, "run.json"), "utf8"));
      run.run_id = "run-held-out-transfer"; run.task_id = "task-001-refund.json";
      await writeFile(join(args.get("runs")!, "extra.json"), JSON.stringify(run));
    }
    if (kind === "extra-cluster") {
      const clusterPath = join(args.get("clusters")!, (await readdir(args.get("clusters")!))[0]!);
      const cluster = JSON.parse(await readFile(clusterPath, "utf8"));
      cluster.members[0].run_id = "run-held-out-transfer";
      await writeFile(clusterPath, JSON.stringify(cluster));
    }
    if (kind === "changed-run") {
      const copy = join(skillDirectory!, "substituted-runs"); await mkdir(copy);
      const run = JSON.parse(await readFile(join(args.get("runs")!, "run.json"), "utf8"));
      run.checks[0].detail = "Unauthorized summary replacement for an allowed run ID";
      await writeFile(join(copy, "run.json"), JSON.stringify(run)); args.set("runs", copy);
    }
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(runMeteredProposal(new Map([...args, ["prepare", "true"]]))).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    await expect(readFile(args.get("manifest")!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(candidateOut!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects omitted development baseline attempts", async () => {
    await skillFixture(); args.set("mode", "live");
    const baselinePath = args.get("development-baseline")!;
    const summary = JSON.parse(await readFile(baselinePath, "utf8")) as E2eSummary;
    const attempt = summary.per_task[0]!.attempts_detail[0]!;
    const runPath = join(skillDirectory!, "omitted-run.json");
    const receiptPath = join(skillDirectory!, "omitted-receipt.json");
    const run = JSON.parse(await readFile(join(args.get("runs")!, "run.json"), "utf8"));
    const receipt = JSON.parse(await readFile(join(skillDirectory!, "baseline-receipt.json"), "utf8"));
    run.run_id = "run-omitted-development-baseline"; run.evidence = [`repo://${skillDirectory!.slice(repo.length + 1)}/omitted-receipt.json`]; receipt.run_id = run.run_id;
    receipt.receipt_id = "rcp-omitted-development-baseline";
    await writeFile(runPath, JSON.stringify(run)); await writeFile(receiptPath, JSON.stringify(receipt));
    const prefix = skillDirectory!.slice(repo.length + 1);
    summary.per_task[0]!.attempts = 2;
    summary.attempts_per_task = 2;
    summary.per_task[0]!.attempts_detail.push({ ...attempt, attempt: 2, run_id: run.run_id,
      run_record_path: `${prefix}/omitted-run.json`, run_record_sha256: sha256(JSON.stringify(run)),
      receipt_path: `${prefix}/omitted-receipt.json`, receipt_sha256: sha256(JSON.stringify(receipt)) });
    const manifestPath = join(repo, summary.transmission_manifest_path);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.attempts_per_task = 2;
    await writeFile(manifestPath, JSON.stringify(manifest));
    summary.transmission_manifest_sha256 = sha256(canonicalJson(manifest));
    const originalReceiptPath = join(skillDirectory!, "baseline-receipt.json");
    const originalReceipt = JSON.parse(await readFile(originalReceiptPath, "utf8"));
    originalReceipt.transmission_manifest_sha256 = summary.transmission_manifest_sha256;
    await writeFile(originalReceiptPath, JSON.stringify(originalReceipt));
    summary.per_task[0]!.attempts_detail[0]!.receipt_sha256 = sha256(JSON.stringify(originalReceipt));
    receipt.transmission_manifest_sha256 = summary.transmission_manifest_sha256;
    await writeFile(receiptPath, JSON.stringify(receipt));
    summary.per_task[0]!.attempts_detail[1]!.receipt_sha256 = sha256(JSON.stringify(receipt));
    await writeFile(baselinePath, JSON.stringify(summary));
    const { assessDevelopmentBaseline } = await import("../benchmarks/tau-style-workflow/skill-adaptation.js");
    expect(await assessDevelopmentBaseline(baselinePath, repo)).toMatchObject({ eligible: true, problems: [] });
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(prepareMeteredProposal(new Map([...args, ["prepare", "true"]]))).rejects.toThrow("match development baseline attempts exactly");
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
  });

  it.each(["summary", "manifest", "receipt", "run"])("regenerates %s baseline evidence before broker startup", async kind => {
    await skillFixture(); args.set("mode", "live");
    const { digest } = await prepare(); await approve(digest);
    const path = kind === "summary" ? args.get("development-baseline")! : kind === "run" ? join(args.get("runs")!, "run.json") : join(skillDirectory!, `baseline-${kind}.json`);
    await writeFile(path, (await readFile(path, "utf8")) + "\n");
    const calls = vi.spyOn(globalThis, "fetch"); const keys = watchKeys();
    await expect(runMeteredProposal(args)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    await expect(readFile(args.get("output")!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rehearsal skill preparation needs no actual-model baseline claim", async () => {
    await skillFixture(); args.delete("development-baseline");
    const { manifest } = await prepare();
    expect(manifest.inputs).not.toHaveProperty("development_baseline");
    expect(manifest.payload).toMatchObject({ output_kind: "optimizer_candidate" });
    expect(external).not.toHaveBeenCalled();
  });
});
