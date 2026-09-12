import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessLive, compareLive, contextDigest, parseLiveArgs, pilotRunRecord, readLiveReceipt } from "../benchmarks/skillsbench-pilot/live.js";
import { outputInventory, privateDirectory, ROOT } from "../benchmarks/skillsbench-pilot/run.js";
import { PILOT_TASKS } from "../benchmarks/skillsbench-pilot/source.js";
import { captureSession, gatewayPolicyTemplate, safeGatewayReceipt } from "../benchmarks/tau-style-workflow/run-e2e.js";
import { prepareMeteredProposal } from "../benchmarks/tau-style-workflow/run-metered-proposal.js";
import { clusterRunRecords } from "../src/clustering.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { validateOptimizerExchange } from "../src/optimizer.js";
import { validateRunRecord } from "../src/runs.js";
import { SCHEMA_IDS } from "../src/schema.js";

let root: string;
beforeEach(async () => {
  const parent = join(ROOT, ".dal/check");
  await privateDirectory(parent);
  root = await mkdtemp(join(parent, "skillsbench-live-test-"));
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const context = () => ({
  task: PILOT_TASKS.development as typeof PILOT_TASKS[keyof typeof PILOT_TASKS], image: `sha256:${sha256("synthetic image")}`,
  provenance: { fixture: "synthetic, not build evidence" },
  drivers: [{ path: "synthetic-driver.ts", sha256: sha256("synthetic driver") }],
  upstream_commit: "0".repeat(40), source_lock: [], patch: "synthetic patch",
  prompt: "Synthetic parser fixture only", provider: "openai", model: "gpt-5.6-terra",
  timeout_ms: 360000, cpus: 1, memory_mb: 4096, network: "candidate-internal-gateway-only",
  cumulative_cap_microusd: 1000000, campaign: "synthetic-skillsbench-test",
});
const junit = (failures = 0, tests = 3, errors = 0, skipped = 0) =>
  `<testsuites><testsuite tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">${["check_alpha", "check_beta", "check_gamma"].map((name, index) =>
    `<testcase name="${name}">${index < failures ? '<failure message="Synthetic assertion failure">private-verifier-detail</failure>' : ""}</testcase>`).join("")}</testsuite></testsuites>`;
const sessionRaw = [
  { type: "tool/call", data: { name: "bash", callId: "synthetic-call", arguments: { command: "private-tool-argument-not-executed" } } },
  { type: "assistant/message", data: { usage: { inputTokens: 17, outputTokens: 9 }, message: { content: [{ type: "text", text: "private-synthetic-transcript" }] } } },
].map(event => JSON.stringify(event)).join("\n") + "\n";
const put = (path: string, value: string) => writeFile(path, value, { mode: 0o600 });
const putJson = (path: string, value: unknown) => put(path, JSON.stringify(value, null, 2));

// These are consumer-shaped local bytes, not receipts from an actual live model or ledger.
async function fixture(name: string, generation = "g0", pass = false, skill = `synthetic skill ${generation}\n`) {
  const dir = join(root, name);
  for (const path of [dir, join(dir, "output"), join(dir, "skills"), join(dir, "skills/obj-exporter"), join(dir, "verification")]) {
    await mkdir(path, { mode: 0o700 });
  }
  const c = context();
  const runId = `run-synthetic-${name}`;
  const policy = gatewayPolicyTemplate(new Map([
    ["mode", "live"], ["campaign", c.campaign], ["provider", c.provider], ["model", c.model],
    ["provider-cap-microusd", String(c.cumulative_cap_microusd)], ["approval-id", "dec-synthetic-not-approval"],
  ]), runId);
  const manifest = {
    version: "skillsbench-live-manifest.v1", ...c, context_sha256: contextDigest(c),
    qualification: { path: "synthetic-not-qualification.json", sha256: sha256("synthetic") },
    batch: name, run_id: runId, generation, policy, ledger_root: join(root, "never-opened-ledger"),
    skill: { uri: `repo://${relative(ROOT, join(dir, "skills/obj-exporter/SKILL.md"))}`, sha256: sha256(skill), bytes: Buffer.byteLength(skill) },
  };
  const gateway = safeGatewayReceipt({
    campaign_id: c.campaign, run_id: runId, provider: c.provider, mode: "live",
    reservations: 1, reserved_microusd: 200, process_counts: { completed: 1, failed: 0, rejected: 0, response_bytes: 100 },
    accounting: "upper-bound-reservations-no-refund",
  }, policy, "live");
  const xml = junit(pass ? 0 : 1);
  const log = "Synthetic verifier log; no subprocess executed.\n";
  await put(join(dir, "output/model.obj"), "# synthetic output\nv 1 2 3\n");
  await put(join(dir, "skills/obj-exporter/SKILL.md"), skill);
  await put(join(dir, "skills/obj-exporter/helper.txt"), "synthetic supporting skill artifact\n");
  await put(join(dir, "verification/junit.xml"), xml);
  await put(join(dir, "verifier.log"), log);
  await putJson(join(dir, "manifest.json"), manifest);
  const gatewayRaw = JSON.stringify(gateway);
  await put(join(dir, "gateway.json"), gatewayRaw);
  const sessionDir = join(dir, "dsh-home/sessions/project/session");
  await privateDirectory(sessionDir);
  await put(join(sessionDir, "session.jsonl"), sessionRaw);
  const receipt = {
    version: "skillsbench-live-receipt.v1", manifest_sha256: sha256(canonicalJson(manifest)),
    manifest_path: relative(ROOT, join(dir, "manifest.json")), run_id: runId, mode: "live",
    execution_succeeded: true, failure: null as string | null,
    started_at: "2026-09-11T00:00:00.000Z", finished_at: "2026-09-11T00:00:02.000Z",
    session: await captureSession(join(dir, "dsh-home")),
    grade: { pass, inventory: await outputInventory(join(dir, "output")), junit_sha256: sha256(xml), verifier_log_sha256: sha256(log) },
    mounted_skills: await outputInventory(join(dir, "skills")), gateway_sha256: sha256(gatewayRaw),
    allocation_before_microusd: 100, allocation_after_microusd: 200,
    promotion_authorized: false, independent_execution_attestation: false,
  };
  const path = relative(ROOT, join(dir, "receipt.json"));
  await putJson(join(ROOT, path), receipt);
  return { dir, path, manifest, receipt, gateway };
}

async function reseal(f: Awaited<ReturnType<typeof fixture>>) {
  f.manifest.context_sha256 = contextDigest(f.manifest);
  f.receipt.manifest_sha256 = sha256(canonicalJson(f.manifest));
  await putJson(join(f.dir, "manifest.json"), f.manifest);
  await putJson(join(ROOT, f.path), f.receipt);
}

describe("SkillsBench live argument boundary", () => {
  it.each([
    [], ["fetch"], ["rehearse"], ["compare", "--provider", "openai"],
    ["prepare", "--model", "other"], ["run", "--gateway-ledger", "/tmp/ledger"],
    ["run", "--provider-cap-microusd", "999999999"], ["run", "--network", "host"],
    ["run", "--env", ".env"], ["run", "--image", "mutable:tag"],
    ["assess", "--skill", "skill.md"], ["compare", "--receipt", "receipt.json"],
    ["assess", "--receipt"], ["assess", "receipt", "a.json"],
    ["assess", "--receipt", ""], ["assess", "--receipt", "--baseline"],
    ["assess", "--receipt", "a.json", "--receipt", "b.json"], ["assess", "--receipt=a.json"],
    ["enroll", "--runs", "runs"], ["enroll", "--receipt"], ["enroll", "--receipt", "a.json", "--receipt", "b.json"],
  ])("rejects unsupported or malformed argv %j", (...argv) => {
    expect(() => parseLiveArgs(argv)).toThrow();
  });
  it("parses the supported action-specific options without executing them", () => {
    expect(parseLiveArgs(["assess", "--receipt", "local.json"])).toEqual({ action: "assess", args: new Map([["receipt", "local.json"]]) });
    expect(parseLiveArgs(["enroll", "--receipt", "local.json"])).toEqual({ action: "enroll", args: new Map([["receipt", "local.json"]]) });
    expect(parseLiveArgs(["compare", "--baseline", "b.json", "--candidate", "c.json"]).args).toEqual(new Map([["baseline", "b.json"], ["candidate", "c.json"]]));
    for (const action of ["prepare", "run"]) {
      const pairs = [["batch", "synthetic"], ["task", PILOT_TASKS.development], ["generation", "g0"], ["skill", "skill.md"], ["qualification", "q.json"], ["approval-id", "dec-synthetic"], ["approval", "a.json"], ["manifest", "m.json"]];
      expect(parseLiveArgs([action, ...pairs.flatMap(([key, value]) => [`--${key}`, value!])]).args).toEqual(new Map(pairs as [string, string][]));
    }
  });
});

describe("SkillsBench paired context", () => {
  it("uses canonical field order and excludes only trial/treatment metadata", () => {
    const c = context();
    expect(contextDigest(c)).toBe(sha256(canonicalJson(c)));
    expect(contextDigest(Object.fromEntries(Object.entries(c).reverse()))).toBe(contextDigest(c));
    expect(contextDigest({ ...c, skill: { sha256: sha256("other skill") }, generation: "g1", batch: "other", run_id: "other", policy: {}, qualification: {}, ledger_root: "other", context_sha256: "ignored" })).toBe(contextDigest(c));
  });
  it.each(Object.keys(context()))("binds %s independently", key => {
    const c = context();
    expect(contextDigest({ ...c, [key]: "changed synthetic context" })).not.toBe(contextDigest(c));
  });
});

describe("synthetic local live receipt evidence", () => {
  it.each([true, false])("reads a fully bound pass=%s outcome and assesses g0 without authorizing promotion", async pass => {
    const f = await fixture("baseline", "g0", pass);
    const read = await readLiveReceipt(f.path);
    expect(read.manifest).toEqual(f.manifest);
    expect(read.receipt).toEqual(f.receipt);
    expect(read.sha256).toBe(sha256(await readFile(join(ROOT, f.path))));
    expect(await assessLive(f.path)).toEqual({
      status: pass ? "no_change_needed" : "failure_requires_causal_review",
      evidence: { path: f.path, sha256: read.sha256 }, promotion_authorized: false,
    });
  });
  it("accepts manifest formatting changes but rejects a raw-byte manifest digest", async () => {
    const f = await fixture("baseline");
    const raw = JSON.stringify(Object.fromEntries(Object.entries(f.manifest).reverse()), null, 4) + "\n";
    await put(join(f.dir, "manifest.json"), raw);
    await expect(readLiveReceipt(f.path)).resolves.toHaveProperty("manifest.context_sha256", contextDigest(f.manifest));
    f.receipt.manifest_sha256 = sha256(raw);
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow("Receipt identity mismatch");
  });
  it.each(["manifest", "context", "run-id"])("rejects mismatched %s identity", async kind => {
    const f = await fixture("baseline");
    if (kind === "run-id") f.receipt.run_id = "run-other";
    else f.manifest.prompt = "modified synthetic prompt";
    if (kind === "context") f.receipt.manifest_sha256 = sha256(canonicalJson(f.manifest));
    await putJson(join(f.dir, "manifest.json"), f.manifest);
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow("Receipt identity mismatch");
  });
  it.each(["output/model.obj", "output/extra.obj", "verifier.log", "verification/junit.xml", "skills/obj-exporter/SKILL.md", "skills/obj-exporter/helper.txt", "skills/extra.txt", "gateway.json"])("rejects modified or added %s bytes", async file => {
    const f = await fixture("baseline");
    const bytes = file === "gateway.json" ? JSON.stringify({ ...f.gateway, reservations: 2 }) : "modified synthetic bytes";
    await put(join(f.dir, file), bytes);
    await expect(readLiveReceipt(f.path)).rejects.toThrow(/evidence|drift/);
  });
  it("checks the selected skill hash even when the mounted inventory is refreshed", async () => {
    const f = await fixture("baseline");
    await put(join(f.dir, "skills/obj-exporter/SKILL.md"), "different synthetic skill");
    f.receipt.mounted_skills = await outputInventory(join(f.dir, "skills"));
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow("Mounted skill drift");
  });
  it.each([
    junit(0, 2), junit(0, 4), junit(0, 0), junit(0, 3, 1), junit(0, 3, 0, 1),
    junit(4), junit(1), "", junit() + junit(),
  ])("rejects invalid JUnit even with a matching file hash: %s", async xml => {
    const f = await fixture("baseline", "g0", true);
    await put(join(f.dir, "verification/junit.xml"), xml);
    f.receipt.grade.junit_sha256 = sha256(xml);
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow(/Verifier|verifier/);
  });
  it.each(["completed", "failed", "rejected", "negative", "fractional", "mode", "provider", "run", "campaign", "accounting", "no-spend", "after", "cap"])("denies invalid gateway %s with a freshly bound gateway hash", async kind => {
    const f = await fixture("baseline");
    const g = { ...f.gateway, process_counts: { ...f.gateway.process_counts } };
    if (kind === "completed") g.process_counts.completed = 0;
    if (kind === "failed") g.process_counts.failed = 1;
    if (kind === "rejected") g.process_counts.rejected = 1;
    if (kind === "negative") g.process_counts.completed = -1;
    if (kind === "fractional") g.process_counts.completed = 0.5;
    if (kind === "run") g.run_id = "run-other";
    if (kind === "campaign") g.campaign_id = "other";
    if (kind === "accounting") g.accounting = "measured-billing";
    if (kind === "no-spend") g.reserved_microusd = f.receipt.allocation_before_microusd;
    if (kind === "after") g.reserved_microusd = f.receipt.allocation_after_microusd + 1;
    if (kind === "cap") g.reserved_microusd = f.manifest.policy.provider_limit_microusd + 1;
    const raw = JSON.stringify({ ...g, ...(kind === "mode" ? { mode: "rehearsal" } : {}), ...(kind === "provider" ? { provider: "anthropic" } : {}) });
    await put(join(f.dir, "gateway.json"), raw);
    f.receipt.gateway_sha256 = sha256(raw);
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow(/Gateway|gateway/);
  });
  it.each(["rehearsal", "execution", "failure", "promotion"])("denies non-completed/unauthorized receipt state %s", async kind => {
    const f = await fixture("baseline");
    if (kind === "rehearsal") f.receipt.mode = "rehearsal";
    if (kind === "execution") f.receipt.execution_succeeded = false;
    if (kind === "failure") f.receipt.failure = "cleanup_failed";
    if (kind === "promotion") f.receipt.promotion_authorized = true;
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(readLiveReceipt(f.path)).rejects.toThrow("Not a completed live business outcome");
  });
});

describe("synthetic paired live comparisons", () => {
  it.each([
    [false, true, 1, "improved_on_evaluated_case"], [false, false, 0, "no_improvement"],
    [true, true, 0, "no_improvement"], [true, false, -1, "regression"],
  ] as const)("compares baseline=%s candidate=%s", async (before, after, delta, status) => {
    const b = await fixture("baseline", "g0", before);
    const c = await fixture("candidate", "g1", after);
    expect(await compareLive(b.path, c.path)).toEqual({
      status, delta, task: PILOT_TASKS.development, evidence: [b.path, c.path], promotion_authorized: false,
      claim: "One paired local evaluation, not an official score or reliability estimate",
    });
  });
  it.each(["baseline-generation", "candidate-generation", "model", "context", "task", "same-artifact", "same-run"])("rejects non-comparable %s after independently validating both receipts", async kind => {
    const b = await fixture("baseline");
    const c = await fixture("candidate", "g1", true, kind === "same-artifact" ? "synthetic skill g0\n" : "synthetic skill g1\n");
    if (kind === "baseline-generation") b.manifest.generation = "g1";
    if (kind === "candidate-generation") c.manifest.generation = "g0";
    if (kind === "model") c.manifest.model = "different-synthetic-model";
    if (kind === "context") c.manifest.timeout_ms++;
    if (kind === "task") c.manifest.task = PILOT_TASKS.transfer;
    if (kind === "same-run") {
      c.manifest.run_id = c.receipt.run_id = c.manifest.policy.run_id = c.gateway.run_id = b.manifest.run_id;
      const raw = JSON.stringify(c.gateway);
      await put(join(c.dir, "gateway.json"), raw);
      c.receipt.gateway_sha256 = sha256(raw);
    }
    await reseal(b); await reseal(c);
    await readLiveReceipt(b.path); await readLiveReceipt(c.path);
    await expect(compareLive(b.path, c.path)).rejects.toThrow("Non-comparable pilot trials");
  });
  it("rejects a duplicate receipt path or copied receipt as a second trial", async () => {
    const b = await fixture("baseline");
    await expect(compareLive(b.path, b.path)).rejects.toThrow("Non-comparable pilot trials");
    const duplicate = join(b.dir, "receipt-copy.json");
    await put(duplicate, await readFile(join(ROOT, b.path), "utf8"));
    await expect(compareLive(b.path, duplicate)).rejects.toThrow("Non-comparable pilot trials");
  });
  it.each(["generation", "task"])("assesses only development g0, not another %s", async kind => {
    const f = await fixture("baseline");
    if (kind === "generation") f.manifest.generation = "g1";
    else f.manifest.task = PILOT_TASKS.transfer;
    await reseal(f);
    await expect(assessLive(f.path)).rejects.toThrow("Require development g0 baseline");
  });
});

describe("session-backed SkillsBench development projection", () => {
  it.each([true, false])("projects and validates a pass=%s baseline without confusing harness and business outcomes", async pass => {
    const f = await fixture("baseline", "g0", pass);
    expect(f.receipt.session).toEqual({ sessionId: "session", eventLogHead: sha256(sessionRaw), observation: {
      tool_calls: 1, input_tokens: 17, output_tokens: 9, get_order_succeeded: false, get_order_then_done: false,
    } });
    const record = await pilotRunRecord(f.path);
    await expect(validateRunRecord(record)).resolves.toEqual(record);
    expect(await pilotRunRecord(f.path)).toEqual(record);
    expect(record).toMatchObject({ run_id: f.manifest.run_id, task_id: PILOT_TASKS.development,
      started_at: f.receipt.started_at, finished_at: f.receipt.finished_at, outcome: "succeeded", failure: null,
      business_outcome: { status: pass ? "passed" : "failed", earned: pass ? 3 : 2, total: 3, score: pass ? 1 : 2 / 3 },
      metrics: { duration_ms: 2000, tool_calls: 1, input_tokens: 17, output_tokens: 9 },
      context: { harness_sha256: f.manifest.context_sha256, context_policy_sha256: f.manifest.context_sha256,
        model: { id: f.manifest.model, version: f.manifest.provider },
        harness_pins: [{ surface: "skills", uri: f.manifest.skill.uri, sha256: f.manifest.skill.sha256 }] },
      artifacts: [], evidence: [`repo://${f.path}`],
    });
    expect(record.checks?.map(check => [check.id, check.pass, check.detail])).toEqual([
      ["test:check_alpha", pass, pass ? "Verifier assertion passed" : "Verifier assertion failed"],
      ["test:check_beta", true, "Verifier assertion passed"], ["test:check_gamma", true, "Verifier assertion passed"],
    ]);
    for (const check of record.checks ?? []) {
      expect(check.goal_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(check.actual_sha256).toBe(sha256(canonicalJson(f.receipt.grade.inventory)));
    }
    for (const text of ["private-verifier-detail", "private-tool-argument", "private-synthetic-transcript", "v 1 2 3"]) {
      expect(JSON.stringify(record)).not.toContain(text);
    }
  });
  it.each(["missing-file", "missing-binding", "changed-bytes", "changed-binding"])("denies %s session evidence", async kind => {
    const f = await fixture("baseline");
    const path = join(f.dir, "dsh-home/sessions/project/session/session.jsonl");
    if (kind === "missing-file") await rm(path);
    if (kind === "missing-binding") f.receipt.session = { sessionId: null, eventLogHead: null };
    if (kind === "changed-bytes") await put(path, sessionRaw + "\n");
    if (kind === "changed-binding") f.receipt.session.eventLogHead = sha256("unbound session");
    await putJson(join(ROOT, f.path), f.receipt);
    await expect(pilotRunRecord(f.path)).rejects.toThrow("Missing or drifted DSH session evidence");
  });
  it.each(["transfer", "g1", "started_at", "finished_at"])("rejects ineligible %s projection", async kind => {
    const f = await fixture("baseline");
    if (kind === "transfer") f.manifest.task = PILOT_TASKS.transfer;
    if (kind === "g1") f.manifest.generation = "g1";
    if (kind === "started_at" || kind === "finished_at") f.receipt[kind] = "not-a-date";
    await reseal(f);
    await expect(pilotRunRecord(f.path)).rejects.toThrow("Only dated development baselines can be enrolled");
  });
  it.each(["missing-check", "invalid-name", "aggregate"])("denies %s in individually projected JUnit checks", async kind => {
    const f = await fixture("baseline");
    let xml = junit(1);
    if (kind === "missing-check") xml = xml.replace('<testcase name="check_gamma"></testcase>', "");
    if (kind === "invalid-name") xml = xml.replace("check_gamma", "unsafe-check-name");
    if (kind === "aggregate") xml = xml.replace(/<failure\b[^>]*>[\s\S]*?<\/failure>/, "");
    await put(join(f.dir, "verification/junit.xml"), xml);
    f.receipt.grade.junit_sha256 = sha256(xml);
    await reseal(f);
    await expect(pilotRunRecord(f.path)).rejects.toThrow(kind === "missing-check" ? "Missing individual checks" : kind === "invalid-name" ? "Unexpected check name" : "Check aggregate mismatch");
  });
});

async function proposalFixture() {
  const f = await fixture("baseline");
  const skillDir = join(root, ".agents/skills/synthetic");
  await privateDirectory(skillDir);
  const base = await readFile(join(f.dir, "skills/obj-exporter/SKILL.md"), "utf8");
  await put(join(skillDir, "SKILL.md"), base);
  const exchange = await validateOptimizerExchange({
    $schema: SCHEMA_IDS.optimizer, schema_version: "1.0.0", exchange_id: "opt-synthetic-skillsbench", mode: "prepare_only", provider_hint: "skillopt",
    target: { kind: "skill", artifact_uri: `repo://${relative(ROOT, join(skillDir, "SKILL.md"))}`, base_sha256: sha256(base), format: "bounded_edits" },
    objective: { goal: "Improve synthetic deterministic checks", metrics: ["task_success_rate"], higher_is_better: true },
    datasets: { train: ["repo://never-read-training.json"], validation: ["repo://never-read-validation.json"], test: ["repo://never-read-holdout.json"] },
    budget: { max_candidates: 1, max_evaluations: 1, max_wall_time_seconds: 30, max_external_cost_usd: 0 },
    privacy: { classification: "internal", external_transfer_approved: false, approval_ref: null }, result: null,
  });
  const exchangePath = join(root, "exchange.json");
  await putJson(exchangePath, exchange);
  const record = await validateRunRecord(await pilotRunRecord(f.path));
  const runs = join(root, "runs"); const clusters = join(root, "clusters");
  await privateDirectory(runs); await privateDirectory(clusters);
  const runPath = join(runs, "development-run.json");
  await put(runPath, `${JSON.stringify(record, null, 2)}\n`);
  const clustered = await clusterRunRecords({ store: runs, output: clusters });
  expect(clustered).toMatchObject({ cluster_count: 1, clustered_business_failures: 1, clustered_harness_failures: 0 });
  const args = new Map(Object.entries({ mode: "live", campaign: f.manifest.campaign, batch: "synthetic-proposal", provider: f.manifest.provider,
    model: f.manifest.model, "provider-cap-microusd": "1000000", "approval-id": "dec-synthetic-not-approval", runs, clusters,
    exchange: exchangePath, "candidate-out": ".dal/candidates/synthetic-skillsbench-not-written.md", "development-baseline": f.path,
  }));
  return { f, record, runPath, clustered, exchange, args };
}

describe("SkillsBench prepare-only metered proposal branch", () => {
  it("binds a real local projection, exchange, and failure cluster without transmitting private evidence", async () => {
    const { f, record, runPath, exchange, args } = await proposalFixture();
    const { manifest, digest } = await prepareMeteredProposal(args);
    expect(digest).toBe(sha256(canonicalJson(manifest)));
    expect((await prepareMeteredProposal(args)).digest).toBe(digest);
    expect(manifest.execution_attestation).toBe(false);
    expect(manifest.skill_proposal?.target).toEqual({ exchange_id: exchange.exchange_id, target_uri: exchange.target.artifact_uri, base_sha256: f.manifest.skill.sha256 });
    expect(manifest.inputs.runs?.files).toEqual([{ name: "development-run.json", sha256: sha256(`${JSON.stringify(record, null, 2)}\n`) }]);
    const baseline = manifest.inputs.development_baseline!;
    expect(baseline).toMatchObject({ path: join(ROOT, f.path), sha256: sha256(await readFile(join(ROOT, f.path))),
      evidence: [{ manifest_path: f.receipt.manifest_path, attempts: [{ receipt_path: f.path, run_record_path: relative(ROOT, runPath) }] }],
    });
    expect(baseline.files.map(file => file.path).sort()).toEqual([
      f.path, f.receipt.manifest_path, relative(ROOT, runPath), ...["gateway.json", "verification/junit.xml", "verifier.log"].map(file => relative(ROOT, join(f.dir, file))),
    ].sort());
    for (const file of baseline.files) expect(file.sha256).toBe(sha256(await readFile(join(ROOT, file.path))));
    const body = canonicalJson(manifest.native_body);
    for (const text of ["private-synthetic-transcript", "private-verifier-detail", "private-tool-argument", "never-read-training", "never-read-validation", "never-read-holdout", "receipt.json", "junit.xml", "v 1 2 3"]) {
      expect(body).not.toContain(text);
    }
    expect(body).toContain("Verifier assertion failed");
  });
  it.each(["passing", "transfer", "g1", "unbound-run", "extra-run", "model", "base", "foreign-cluster"])("rejects %s evidence in the SkillsBench branch", async kind => {
    const { f, record, runPath, clustered, args } = await proposalFixture();
    if (kind === "passing") {
      const xml = junit();
      await put(join(f.dir, "verification/junit.xml"), xml);
      f.receipt.grade.pass = true; f.receipt.grade.junit_sha256 = sha256(xml);
    }
    if (kind === "transfer") f.manifest.task = PILOT_TASKS.transfer;
    if (kind === "g1") f.manifest.generation = "g1";
    if (kind === "model") f.manifest.model = "different-synthetic-model";
    if (kind === "base") {
      const skill = "different synthetic base\n";
      await put(join(f.dir, "skills/obj-exporter/SKILL.md"), skill);
      f.manifest.skill.sha256 = sha256(skill); f.manifest.skill.bytes = Buffer.byteLength(skill);
      f.receipt.mounted_skills = await outputInventory(join(f.dir, "skills"));
    }
    await reseal(f);
    if (kind === "passing") await put(runPath, `${JSON.stringify(await pilotRunRecord(f.path), null, 2)}\n`);
    if (kind === "unbound-run") {
      record.metrics.tool_calls++;
      await validateRunRecord(record);
      await put(runPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    if (kind === "extra-run") await putJson(join(root, "runs/extra.json"), { ...record, run_id: "run-synthetic-extra" });
    if (kind === "foreign-cluster") {
      const path = clustered.clusters[0]!.path;
      const cluster = JSON.parse(await readFile(path, "utf8"));
      cluster.members[0].run_id = cluster.representative.run_id = "run-synthetic-foreign";
      await putJson(path, cluster);
    }
    const error = kind === "transfer" || kind === "g1" ? "Only dated development baselines can be enrolled"
      : kind === "unbound-run" ? "SkillsBench development projection drift"
      : kind === "extra-run" ? "SkillsBench requires exactly its enrolled development run"
      : kind === "foreign-cluster" ? "SkillsBench proposal contains nondevelopment evidence"
      : "SkillsBench development failure/model/base mismatch";
    await expect(prepareMeteredProposal(args)).rejects.toThrow(error);
  });
});
