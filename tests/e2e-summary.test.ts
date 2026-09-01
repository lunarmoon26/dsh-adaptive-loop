import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareGate, isE2eSummary, readSummary, verifyReceipts, type E2eSummary, type TaskSummary } from "../benchmarks/tau-style-workflow/e2e-summary.js";
import { canonicalJson, sha256 } from "../src/json.js";

function taskSummary(taskId: string, passed: number, attempts: number, details: TaskSummary["attempts_detail"]): TaskSummary {
  return {
    task_id: taskId,
    attempts,
    passed,
    mean: passed / attempts,
    pass_at_1: details[0]?.passed ?? false,
    checkpoint_pass: passed > 0,
    attempts_detail: details,
  };
}

function missingDetail(passed: boolean, attempt: number, id: string): TaskSummary["attempts_detail"][number] {
  return {
    attempt,
    run_id: `run-missing-${id}`,
    run_record_path: `runs/missing-${id}.json`,
    run_record_sha256: "e".repeat(64),
    receipt_path: `receipts/missing-${id}.json`,
    receipt_sha256: "f".repeat(64),
    state_sha256: "a".repeat(64),
    passed,
  };
}

function summaryIdentity(
  batch: string,
  attempts: number,
  taskIds: string[] = [],
  model = { provider: "deepseek-official", model: "deepseek-v4-flash" },
) {
  const generation = batch.startsWith("g0") ? "g0" as const : "g1" as const;
  const candidateSha256 = (generation === "g0" ? "0" : "1").repeat(64);
  const benchmarkContextSha256 = "b".repeat(64);
  const manifest = {
    provider: model.provider,
    model: model.model,
    generation,
    attempts_per_task: attempts,
    runner: "docker",
    faults: null,
    resolutions: null,
    skill_sha256: candidateSha256,
    benchmark_context_sha256: benchmarkContextSha256,
    container_image_sha256: "3".repeat(64),
    evaluator_tasks: taskIds.map((taskId) => ({ task_id: taskId, sha256: "4".repeat(64) })),
  };
  return {
    generation,
    candidateSha256,
    benchmarkContextSha256,
    manifest,
    manifestPath: join("manifests", `${batch}.json`),
    manifestSha256: sha256(canonicalJson(manifest)),
    model,
  };
}

function summaryFor(
  batch: string,
  tasks: TaskSummary[],
  model = { provider: "deepseek-official", model: "deepseek-v4-flash" },
): E2eSummary {
  const outcomes: number[] = tasks.flatMap((task) => task.attempts_detail.map((detail) => (detail.passed ? 1 : 0)));
  const mean = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const meanOfSquares = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value * value, 0) / outcomes.length;
  const attempts = tasks[0]?.attempts ?? 1;
  const identity = summaryIdentity(batch, attempts, tasks.map((task) => task.task_id), model);
  return {
    format: "e2e-summary-v1",
    summary_id: `esm-${batch}-00000000`,
    created_at: "2026-08-30T00:00:00.000Z",
    batch,
    task_set: tasks.map((task) => task.task_id),
    model,
    generation: identity.generation,
    candidate_sha256: identity.candidateSha256,
    benchmark_context_sha256: identity.benchmarkContextSha256,
    transmission_manifest_path: identity.manifestPath,
    transmission_manifest_sha256: identity.manifestSha256,
    runner: "docker",
    faults: null,
    resolutions: null,
    attempts_per_task: attempts,
    per_task: tasks,
    overall: {
      mean_success_rate: mean,
      pass_at_1: tasks.length === 0 ? 0 : tasks.filter((task) => task.pass_at_1).length / tasks.length,
      checkpoint_rate: tasks.length === 0 ? 0 : tasks.filter((task) => task.checkpoint_pass).length / tasks.length,
      variance: meanOfSquares - mean * mean,
    },
  };
}

async function writeSummaryManifest(directory: string, summary: E2eSummary): Promise<void> {
  const identity = summaryIdentity(summary.batch, summary.attempts_per_task, summary.task_set, summary.model);
  const path = join(directory, summary.transmission_manifest_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(identity.manifest, null, 2)}\n`, "utf8");
}

async function receiptFor(
  directory: string,
  receiptId: string,
  afterSha: string,
  identity: ReturnType<typeof summaryIdentity>,
  taskId: string,
  businessPassed = true,
): Promise<{ path: string; digest: string; runId: string; runRecordPath: string; runRecordDigest: string }> {
  const runId = receiptId.replace(/^rcp-/, "run-");
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: receiptId,
    run_id: runId,
    created_at: "2026-08-30T00:10:00.000Z",
    candidate_sha256: identity.candidateSha256,
    base_generation_id: "g0",
    candidate_generation_id: identity.generation,
    effective_composition_sha256: "d".repeat(64),
    task_handle: taskId,
    model: identity.model,
    model_patch_sha256: "e".repeat(64),
    dsh_session_id: null,
    event_log_head_sha256: null,
    container_image_sha256: "3".repeat(64),
    transmission_manifest_sha256: identity.manifestSha256,
    external_state_before_sha256: "0".repeat(64),
    external_state_after_sha256: afterSha,
    grader_receipt_sha256: "1".repeat(64),
    source: "repo://tests/e2e-summary.test.ts",
    isolation: {
      topology: "candidate-service-grader-v1",
      candidate_workspace_sha256: "2".repeat(64),
      candidate_workspace_read_only: true,
      candidate_repository_mounted: false,
      service_state_access: "typed-endpoint-only",
      oracle_access: "grader-only",
    },
    business_outcome: {
      status: businessPassed ? "passed" : "failed",
      source: "repo://tests/e2e-summary.test.ts",
      score: businessPassed ? 1 : 0,
      earned: businessPassed ? 1 : 0,
      total: 1,
    },
  };
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  const path = join(directory, `${receiptId}.json`);
  await writeFile(path, raw, "utf8");
  const root = dirname(directory);
  const runRecordPath = join("runs", `${runId}.json`);
  const runRecord = {
    $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
    schema_version: "1.0.0",
    run_id: runId,
    task_id: taskId,
    change_id: "chg-e2e-test",
    started_at: "2026-08-30T00:00:00.000Z",
    finished_at: "2026-08-30T00:10:00.000Z",
    outcome: "succeeded",
    failure: null,
    context: {
      task_set: "tau-style-workflow-e2e",
      environment_snapshot: "test fixture",
      tool_versions: [],
      model: { id: identity.model.model, version: identity.model.provider },
      prompt_sha256: null,
      harness_sha256: null,
      grader_version: "2.0.0",
      seeds: [],
      context_policy_sha256: null,
      inference_parameters: [],
      harness_pins: [{ surface: "skills", uri: "repo://fixture-skill", sha256: identity.candidateSha256 }],
    },
    artifacts: [],
    checks: businessPassed ? [] : [{
      id: "business-verdict",
      pass: false,
      detail: "fixture failure",
      goal_sha256: "7".repeat(64),
      actual_sha256: afterSha,
    }],
    business_outcome: {
      status: businessPassed ? "passed" : "failed",
      source: "repo://tests/e2e-summary.test.ts",
      score: businessPassed ? 1 : 0,
      earned: businessPassed ? 1 : 0,
      total: 1,
    },
    metrics: { duration_ms: 1, tool_calls: 0 },
    evidence: [`repo://${join("receipts", `${receiptId}.json`)}`],
    privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
  };
  const runRecordRaw = `${JSON.stringify(runRecord, null, 2)}\n`;
  await mkdir(join(root, "runs"), { recursive: true });
  await writeFile(join(root, runRecordPath), runRecordRaw, "utf8");
  return {
    path,
    digest: sha256(raw),
    runId,
    runRecordPath,
    runRecordDigest: sha256(runRecordRaw),
  };
}

const cleanups: string[] = [];

afterEach(async () => {
  for (const directory of cleanups.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("e2e pass@k summary and compare gate", () => {
  it("validates the summary artifact shape", async () => {
    const detail = {
      attempt: 1,
      run_id: "run-00000001",
      run_record_path: "runs/run-00000001.json",
      run_record_sha256: "e".repeat(64),
      receipt_path: "receipts/x.json",
      receipt_sha256: "f".repeat(64),
      state_sha256: "a".repeat(64),
      passed: true,
    };
    const summary = summaryFor("g0", [taskSummary("a.json", 1, 1, [detail])]);
    expect(isE2eSummary(summary)).toBe(true);
    expect(isE2eSummary({ ...summary, format: "other" })).toBe(false);
    expect(isE2eSummary({ ...summary, generation: "g2" })).toBe(false);
    expect(isE2eSummary({ ...summary, model: undefined })).toBe(false);
    expect(isE2eSummary({ ...summary, per_task: [{ ...summary.per_task[0], attempts_detail: [{}] }] })).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), "e2e-summary-"));
    cleanups.push(directory);
    const path = join(directory, "summary.json");
    await writeFile(path, `${JSON.stringify(summary)}\n`, "utf8");
    await expect(readSummary(path)).resolves.toEqual(summary);
  });

  it("passes the gate when mean improves, no task regresses, and all receipts bind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const receiptsDir = join(directory, "receipts");
    await mkdir(receiptsDir, { recursive: true });

    const g0Identity = summaryIdentity("g0", 2, ["task-a.json"]);
    const g1Identity = summaryIdentity("g1", 2, ["task-a.json"]);
    const g0a = await receiptFor(receiptsDir, "rcp-g0-00000001", "a".repeat(64), g0Identity, "task-a.json");
    const g0b = await receiptFor(receiptsDir, "rcp-g0-00000002", "a".repeat(64), g0Identity, "task-a.json", false);
    const g1a = await receiptFor(receiptsDir, "rcp-g1-00000001", "a".repeat(64), g1Identity, "task-a.json");
    const g1b = await receiptFor(receiptsDir, "rcp-g1-00000002", "a".repeat(64), g1Identity, "task-a.json");
    const detail = (receipt: Awaited<ReturnType<typeof receiptFor>>, attempt: number, passed: boolean) => ({
      attempt,
      run_id: receipt.runId,
      run_record_path: receipt.runRecordPath,
      run_record_sha256: receipt.runRecordDigest,
      receipt_path: join("receipts", basename(receipt.path)),
      receipt_sha256: receipt.digest,
      state_sha256: "a".repeat(64),
      passed,
    });
    const g0 = summaryFor("g0", [
      taskSummary("task-a.json", 1, 2, [
        detail(g0a, 1, true),
        detail(g0b, 2, false),
      ]),
    ]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 2, 2, [
        detail(g1a, 1, true),
        detail(g1b, 2, true),
      ]),
    ]);
    await Promise.all([writeSummaryManifest(directory, g0), writeSummaryManifest(directory, g1)]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(true);
    expect(gate.problems).toEqual([]);
    expect(gate.notes.join("; ")).toContain("receipts valid 4/4");
  });

  it("fails the gate on an overall mean regression", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const g0 = summaryFor("g0", [taskSummary("task-a.json", 2, 2, [missingDetail(true, 1, "g0-1"), missingDetail(true, 2, "g0-2")])]);
    const g1 = summaryFor("g1", [taskSummary("task-a.json", 1, 2, [missingDetail(true, 1, "g1-1"), missingDetail(false, 2, "g1-2")])]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("overall mean regressed");
  });

  it("fails the gate on a per-task regression even when the overall mean holds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const g0 = summaryFor("g0", [
      taskSummary("task-a.json", 0, 2, [missingDetail(false, 1, "g0-a1"), missingDetail(false, 2, "g0-a2")]),
      taskSummary("task-b.json", 2, 2, [missingDetail(true, 1, "g0-b1"), missingDetail(true, 2, "g0-b2")]),
    ]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 1, 2, [missingDetail(true, 1, "g1-a1"), missingDetail(false, 2, "g1-a2")]),
      taskSummary("task-b.json", 1, 2, [missingDetail(true, 1, "g1-b1"), missingDetail(false, 2, "g1-b2")]),
    ]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("regressed tasks");
    expect(gate.problems.join("; ")).toContain("task-b.json");
  });

  it("fails the gate when a receipt no longer binds the recorded state digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const receiptsDir = join(directory, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    const receipt = await receiptFor(
      receiptsDir,
      "rcp-g1-00000001",
      "a".repeat(64),
      summaryIdentity("g1", 1, ["task-a.json"]),
      "task-a.json",
    );
    const g0 = summaryFor("g0", [taskSummary("task-a.json", 1, 1, [])]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 1, 1, [
        {
          attempt: 1,
          run_id: receipt.runId,
          run_record_path: receipt.runRecordPath,
          run_record_sha256: receipt.runRecordDigest,
          receipt_path: join("receipts", "rcp-g1-00000001.json"),
          receipt_sha256: receipt.digest,
          state_sha256: "b".repeat(64),
          passed: true,
        },
      ]),
    ]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("BRANCH_RECEIPT_MISMATCH");
  });

  it("fails the gate when a receipt file is missing or its digest changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const g0 = summaryFor("g0", [taskSummary("task-a.json", 1, 1, [])]);
    const detail = missingDetail(true, 1, "receipt");
    const g1 = summaryFor("g1", [taskSummary("task-a.json", 1, 1, [detail])]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("receipt file missing");
  });

  it("fails the gate when the stored transmission manifest was changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const reference = summaryFor("g0", []);
    const current = summaryFor("g1", []);
    await Promise.all([writeSummaryManifest(directory, reference), writeSummaryManifest(directory, current)]);
    await writeFile(join(directory, current.transmission_manifest_path), "{}\n", "utf8");

    const gate = await compareGate(current, reference, directory);
    expect(gate.problems.join("; ")).toContain("transmission manifest digest mismatch");
  });

  it("fails the gate when receipt benchmark identities do not match the summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const receiptsDir = join(directory, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    const identity = summaryIdentity("g1", 1, ["task-a.json"]);
    const receipt = await receiptFor(receiptsDir, "rcp-g1-reassigned-0001", "a".repeat(64), identity, "task-a.json");
    const value = JSON.parse(await readFile(receipt.path, "utf8")) as Record<string, unknown>;
    value.task_handle = "task-b.json";
    value.run_id = "run-reassigned-other";
    value.candidate_sha256 = "2".repeat(64);
    value.model = { provider: "other", model: "other" };
    value.candidate_generation_id = "g0";
    value.transmission_manifest_sha256 = "5".repeat(64);
    value.container_image_sha256 = "6".repeat(64);
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(receipt.path, raw, "utf8");
    const reference = summaryFor("g0", [taskSummary("task-a.json", 1, 1, [])]);
    const current = summaryFor("g1", [taskSummary("task-a.json", 1, 1, [{
      attempt: 1,
      run_id: receipt.runId,
      run_record_path: receipt.runRecordPath,
      run_record_sha256: receipt.runRecordDigest,
      receipt_path: join("receipts", "rcp-g1-reassigned-0001.json"),
      receipt_sha256: sha256(raw),
      state_sha256: "a".repeat(64),
      passed: true,
    }])]);
    await Promise.all([writeSummaryManifest(directory, reference), writeSummaryManifest(directory, current)]);

    const gate = await compareGate(current, reference, directory);
    const problems = gate.problems.join("; ");
    expect(problems).toContain("receipt task does not match the summary task");
    expect(problems).toContain("receipt run id does not match the summary attempt");
    expect(problems).toContain("receipt candidate does not match the summary candidate");
    expect(problems).toContain("receipt model does not match the summary model");
    expect(problems).toContain("receipt generation does not match the summary generation");
    expect(problems).toContain("receipt is not bound to the summary transmission manifest");
    expect(problems).toContain("receipt image does not match the transmission manifest");
  });

  it("rejects reused receipts and pass flags that disagree with receipt outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const receiptsDir = join(directory, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    const identity = summaryIdentity("g1", 2, ["task-a.json"]);
    const receipt = await receiptFor(receiptsDir, "rcp-g1-reused-0001", "a".repeat(64), identity, "task-a.json");
    const detail = (attempt: number, passed: boolean) => ({
      attempt,
      run_id: receipt.runId,
      run_record_path: receipt.runRecordPath,
      run_record_sha256: receipt.runRecordDigest,
      receipt_path: join("receipts", "rcp-g1-reused-0001.json"),
      receipt_sha256: receipt.digest,
      state_sha256: "a".repeat(64),
      passed,
    });
    const summary = summaryFor("g1", [taskSummary("task-a.json", 1, 2, [detail(1, true), detail(2, false)])]);
    await writeSummaryManifest(directory, summary);

    const verification = await verifyReceipts(summary, directory);
    expect(verification.failures.join("; ")).toContain("receipt evidence is reused by multiple attempts");
    expect(verification.failures.join("; ")).toContain("receipt business outcome does not match the summary attempt");
  });

  it("fails the gate when a legacy receipt has no physical-isolation evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const receiptsDir = join(directory, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    const receipt = await receiptFor(
      receiptsDir,
      "rcp-g1-legacy-0001",
      "a".repeat(64),
      summaryIdentity("g1", 1, ["task-a.json"]),
      "task-a.json",
    );
    const value = JSON.parse(await readFile(receipt.path, "utf8")) as Record<string, unknown>;
    delete value.isolation;
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(receipt.path, raw, "utf8");
    const reference = summaryFor("g0", [taskSummary("task-a.json", 1, 1, [])]);
    const current = summaryFor("g1", [taskSummary("task-a.json", 1, 1, [{
      attempt: 1,
      run_id: receipt.runId,
      run_record_path: receipt.runRecordPath,
      run_record_sha256: receipt.runRecordDigest,
      receipt_path: join("receipts", "rcp-g1-legacy-0001.json"),
      receipt_sha256: sha256(raw),
      state_sha256: "a".repeat(64),
      passed: true,
    }])]);
    const gate = await compareGate(current, reference, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("does not prove candidate-service-grader-v1 isolation");
  });

  it("fails the gate when frozen benchmark context differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const reference = summaryFor("g0", []);
    const current = { ...summaryFor("g1", []), benchmark_context_sha256: "c".repeat(64) };
    const gate = await compareGate(current, reference, directory);
    expect(gate.problems.join("; ")).toContain("benchmark context mismatch");
  });

  it("rejects a candidate and model change in the same comparison", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const reference = summaryFor("g0", []);
    const current = { ...summaryFor("g1", []), model: { provider: "openai", model: "gpt-5.6-luna" } };
    const gate = await compareGate(current, reference, directory);
    expect(gate.problems.join("; ")).toContain("improvement attribution is confounded");
  });

  it("allows a same-generation provider comparison only with the same candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const reference = summaryFor("g1-reference", []);
    const current = summaryFor("g1-current", [], { provider: "openai", model: "gpt-5.6-luna" });
    await Promise.all([writeSummaryManifest(directory, reference), writeSummaryManifest(directory, current)]);
    const gate = await compareGate(current, reference, directory);
    expect(gate.pass).toBe(true);

    const changedCandidate = { ...current, candidate_sha256: "2".repeat(64) };
    const changedGate = await compareGate(changedCandidate, reference, directory);
    expect(changedGate.problems.join("; ")).toContain("distinct explicit generation labels");
  });
});
