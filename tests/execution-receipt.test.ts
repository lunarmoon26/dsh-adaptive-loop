import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { recordBranch, evaluateBranch, branchStats } from "../src/branch.js";
import { validateExecutionReceipt } from "../src/execution-receipt.js";
import { sha256 } from "../src/json.js";
import { gradeTask, parseWorkflowEffectLog, stableJson, type WorkflowTask } from "../src/workflow-grader.js";

const repoRoot = resolve(import.meta.dirname, "..");
const workspace = resolve(repoRoot, "benchmarks", "tau-style-workflow");
const taskPath = resolve(workspace, "tasks", "task-001-refund.json");
const statePath = resolve(workspace, "dal", "fixtures", "result-pass.json");
const refusalTaskPath = resolve(workspace, "tasks", "task-003-policy-refusal.json");
const refusalStatePath = resolve(workspace, "dal", "fixtures", "result-refusal.json");
const refusalEffectsPath = resolve(workspace, "dal", "fixtures", "effects-refusal.jsonl");

async function setupBranch(store: string): Promise<string> {
  const draftPath = join(store, "draft.json");
  const draft = {
    $schema: "https://recursive-dev-loop.dev/schemas/proposal-draft.v1.schema.json",
    schema_version: "1.0.0",
    draft_id: `drf-${randomUUID().slice(0, 8)}`,
    created_at: "2026-08-30T00:00:00.000Z",
    payload_sha256: "a".repeat(64),
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    surface: "skills",
    target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
    base_sha256: "b".repeat(64),
    title: "Fixture draft",
    objective: "Exercise the receipt chain.",
    statement: "Raises task_success_rate by at least 0.1.",
    improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }],
    regressions: [],
    provenance: { runner: "injected", clusters: [] },
  };
  await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const candidatePath = join(store, "candidate.md");
  await writeFile(candidatePath, "Candidate skill fixture\n");
  const recorded = await recordBranch({ branchId: `brn-receipt-${randomUUID().slice(0, 8)}`, parentBranchId: null, draftPath, candidatePath, store });
  return recorded.branch.branch_id;
}

async function receiptFor(store: string, afterSha: string, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const readFile = (await import("node:fs/promises")).readFile;
  const task = JSON.parse(await readFile(taskPath, "utf8")) as WorkflowTask;
  const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  const verdict = gradeTask(task, state);
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: `rcp-${randomUUID().slice(0, 8)}`,
    created_at: "2026-08-30T00:10:00.000Z",
    candidate_sha256: sha256("Candidate skill fixture\n"),
    base_generation_id: "g0",
    candidate_generation_id: "g1",
    effective_composition_sha256: "d".repeat(64),
    task_handle: "task-001-refund",
    task_sha256: sha256(await readFile(taskPath)),
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    model_patch_sha256: "e".repeat(64),
    dsh_session_id: "session-42",
    event_log_head_sha256: "f".repeat(64),
    business_effect_log_head_sha256: null,
    container_image_sha256: "3".repeat(64),
    external_state_before_sha256: "0".repeat(64),
    external_state_after_sha256: afterSha,
    grader_receipt_sha256: sha256(stableJson(verdict)),
    source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
    isolation: {
      topology: "candidate-service-grader-v1",
      candidate_workspace_sha256: "5".repeat(64),
      candidate_workspace_read_only: true,
      candidate_repository_mounted: false,
      service_state_access: "typed-endpoint-only",
      oracle_access: "grader-only",
    },
    business_outcome: { status: "passed", source: "repo://benchmarks/tau-style-workflow/grader/grade.ts", score: 1, earned: 3, total: 3 },
    ...overrides,
  };
  const path = join(store, "receipt.json");
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

describe("execution receipts (audit P0-2)", () => {
  it.each(["draft.json", "candidate.md"])("reverifies %s before receipt evaluation", async (file) => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    const path = join(store, file);
    await writeFile(path, (await readFile(path, "utf8")) + "\n");
    await expect(evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath })).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("rejects missing proof files rather than returning partial scores", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath });
    await unlink(receiptPath);
    await expect(branchStats({ store })).rejects.toMatchObject({ code: "FILE_READ_FAILED" });
  });

  it.each(["new-id", "new-session", "cross-branch"])("statistics rejects directly inserted conflicting %s evidence", async (reuse) => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    const recorded = await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const evaluation = { ...recorded.evaluation };
    if (reuse === "new-id") receipt.receipt_id = "rcp-other-identity";
    if (reuse === "new-session") receipt.dsh_session_id = "another-session";
    if (reuse === "cross-branch") {
      evaluation.branch_id = "brn-other-binding";
      await recordBranch({ branchId: evaluation.branch_id, parentBranchId: null, draftPath: join(store, "draft.json"), candidatePath: join(store, "candidate.md"), store });
    }
    const anotherPath = join(store, "another-receipt.json");
    await writeFile(anotherPath, JSON.stringify(receipt));
    evaluation.receipt_ref = new URL(`file://${anotherPath}`).href;
    evaluation.receipt_id = receipt.receipt_id;
    evaluation.receipt_sha256 = sha256(await readFile(anotherPath));
    const { receipt_id: _id, created_at: _time, ...content } = receipt;
    evaluation.receipt_content_sha256 = sha256(stableJson(content));
    evaluation.execution_sha256 = sha256(stableJson([receipt.dsh_session_id, receipt.task_handle]));
    evaluation.evaluation_id = `bev-${evaluation.execution_sha256}`;
    await writeFile(join(store, "inserted.evaluation.json"), JSON.stringify(evaluation));
    await expect(branchStats({ store })).rejects.toMatchObject({ code: "BRANCH_EVALUATION_CONFLICT" });
  });

  it.each([
    { candidate_sha256: "a".repeat(64) },
    { grader_receipt_sha256: null },
    { task_sha256: undefined },
    { base_generation_id: null },
    { candidate_generation_id: null },
    { dsh_session_id: null },
    { model_patch_sha256: null },
    { event_log_head_sha256: null },
    { external_state_before_sha256: null },
    { business_effect_log_head_sha256: "2".repeat(64) },
  ])("rejects incomplete or wrong receipt binding %j", async (overrides) => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)), overrides);
    await expect(evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath }))
      .rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
    expect((await branchStats({ store }))[0]?.visits).toBe(0);
  });

  it("keeps old receipts schema-valid but rejects changed same-ID task bytes", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    delete receipt.task_sha256;
    await expect(validateExecutionReceipt(receipt)).resolves.toBeDefined();
    await expect(validateExecutionReceipt({ ...receipt, task_sha256: "invalid" })).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
    const changedTaskPath = join(store, "task.json");
    await writeFile(changedTaskPath, (await readFile(taskPath, "utf8")) + "\n");
    await expect(evaluateBranch({ branchId, taskPath: changedTaskPath, candidateStatePath: statePath, store, receiptPath }))
      .rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it.each(["draft", "artifact", "task", "state", "receipt", "score", "checks", "artifact-ref", "missing-proof"])("fails closed on postrecord %s drift", async (target) => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const localTask = join(store, "task.json");
    const localState = join(store, "state.json");
    await writeFile(localTask, await readFile(taskPath));
    await writeFile(localState, await readFile(statePath));
    const receiptPath = await receiptFor(store, sha256(await readFile(localState)));
    const result = await evaluateBranch({ branchId, taskPath: localTask, candidateStatePath: localState, store, receiptPath });
    expect((await branchStats({ store }))[0]?.visits).toBe(1);
    const files: Record<string, string> = { draft: join(store, "draft.json"), artifact: join(store, "candidate.md"), task: localTask, state: localState, receipt: receiptPath };
    if (files[target]) {
      await writeFile(files[target]!, (await readFile(files[target]!, "utf8")) + "\n");
    } else {
      const evaluation = JSON.parse(await readFile(result.path, "utf8"));
      if (target === "score") evaluation.score = 0;
      if (target === "checks") evaluation.checks[0].pass = !evaluation.checks[0].pass;
      if (target === "artifact-ref") evaluation.candidate_artifact_ref = evaluation.candidate_ref;
      if (target === "missing-proof") delete evaluation.task_sha256;
      await writeFile(result.path, JSON.stringify(evaluation));
    }
    await expect(branchStats({ store })).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("reverifies effect-log bytes during statistics", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const raw = await readFile(refusalEffectsPath, "utf8");
    const effectLogPath = join(store, "effects.jsonl");
    await writeFile(effectLogPath, raw);
    const verdict = gradeTask(JSON.parse(await readFile(refusalTaskPath, "utf8")), JSON.parse(await readFile(refusalStatePath, "utf8")), parseWorkflowEffectLog(raw));
    const receiptPath = await receiptFor(store, sha256(await readFile(refusalStatePath)), {
      task_handle: verdict.task_id, task_sha256: sha256(await readFile(refusalTaskPath)),
      business_effect_log_head_sha256: sha256(raw), grader_receipt_sha256: sha256(stableJson(verdict)),
    });
    await evaluateBranch({ branchId, taskPath: refusalTaskPath, candidateStatePath: refusalStatePath, effectLogPath, store, receiptPath });
    await writeFile(effectLogPath, raw + "\n");
    await expect(branchStats({ store })).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("publishes concurrent exact retries idempotently and counts copied evaluations once", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    const options = { branchId, taskPath, candidateStatePath: statePath, store, receiptPath };
    const results = await Promise.all(Array.from({ length: 5 }, () => evaluateBranch(options)));
    expect(results.filter((result) => result.status === "recorded")).toHaveLength(1);
    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect((await evaluateBranch(options)).status).toBe("idempotent");
    await writeFile(join(store, "copy.evaluation.json"), await readFile(results[0]!.path));
    expect((await branchStats({ store }))[0]?.visits).toBe(1);
  });

  it.each(["new-id", "new-session", "cross-branch"])("rejects reused receipt/execution identity: %s", async (reuse) => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (reuse === "new-id") receipt.receipt_id = "rcp-another-id";
    if (reuse === "new-session") receipt.dsh_session_id = "session-another";
    const anotherReceipt = join(store, "another-receipt.json");
    await writeFile(anotherReceipt, JSON.stringify(receipt));
    let targetBranch = branchId;
    if (reuse === "cross-branch") {
      targetBranch = "brn-another-branch";
      await recordBranch({ branchId: targetBranch, parentBranchId: null, draftPath: join(store, "draft.json"), candidatePath: join(store, "candidate.md"), store });
    }
    await expect(evaluateBranch({ branchId: targetBranch, taskPath, candidateStatePath: statePath, store, receiptPath: anotherReceipt }))
      .rejects.toMatchObject({ code: "BRANCH_EVALUATION_CONFLICT" });
    expect((await branchStats({ store })).reduce((sum, entry) => sum + entry.visits, 0)).toBe(1);
  });

  it("excludes historical true flags and rejects malformed evaluation stores", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const result = await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store });
    expect((await branchStats({ store }))[0]?.visits).toBe(0);
    await writeFile(result.path, JSON.stringify({ ...result.evaluation, provenance_valid: true }));
    expect((await branchStats({ store }))[0]?.visits).toBe(0);
    await writeFile(join(store, "malformed.evaluation.json"), "{");
    await expect(branchStats({ store })).rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(branchStats({ store: join(store, "absent") })).resolves.toEqual([]);
    await expect(branchStats({ store: result.path })).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("keeps historical branches diagnostic-only without an artifact binding", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const path = join(store, `${branchId}.branch.json`);
    const branch = JSON.parse(await readFile(path, "utf8"));
    delete branch.candidate_artifact_ref;
    delete branch.candidate_artifact_sha256;
    await writeFile(path, JSON.stringify(branch));
    await expect(evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store })).resolves.toMatchObject({ evaluation: { provenance_valid: false } });
    const receiptPath = await receiptFor(store, sha256(await readFile(statePath)));
    await expect(evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath })).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("validates the receipt chain schema", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const stateDigest = sha256(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
    const receipt = JSON.parse(await (await import("node:fs/promises")).readFile(await receiptFor(store, stateDigest), "utf8")) as unknown;
    await expect(validateExecutionReceipt(receipt)).resolves.toBeDefined();
    const broken = { ...(receipt as Record<string, unknown>), external_state_after_sha256: "zz" };
    await expect(validateExecutionReceipt(broken)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
    const invalidIsolation = {
      ...(receipt as Record<string, unknown>),
      isolation: { ...((receipt as Record<string, unknown>).isolation as object), candidate_repository_mounted: true },
    };
    await expect(validateExecutionReceipt(invalidIsolation)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("binds branch evaluations to the receipt's external state", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const stateDigest = sha256(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
    const receiptPath = await receiptFor(store, stateDigest);

    const bound = await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath });
    expect(bound.evaluation.provenance_valid).toBe(true);
    expect(bound.evaluation.receipt_id).toMatch(/^rcp-/);
    expect(bound.evaluation.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);

    const mismatched = await receiptFor(store, "0".repeat(64));
    await expect(
      evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath: mismatched }),
    ).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("rejects receipts naming a different task or verdict", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const stateDigest = sha256(await (await import("node:fs/promises")).readFile(statePath, "utf8"));

    const wrongTask = await receiptFor(store, stateDigest, { task_handle: "task-002-booking-change" });
    await expect(
      evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath: wrongTask }),
    ).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });

    const wrongVerdict = await receiptFor(store, stateDigest, { grader_receipt_sha256: "4".repeat(64) });
    await expect(
      evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store, receiptPath: wrongVerdict }),
    ).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });

  it("marks receipt-less evaluations as provenance-invalid", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const result = await evaluateBranch({ branchId, taskPath, candidateStatePath: statePath, store });
    expect(result.evaluation.provenance_valid).toBe(false);
    expect(result.evaluation.receipt_id).toBeNull();
  });

  it("requires and receipt-binds effect evidence for refusal-task branch evaluations", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const branchId = await setupBranch(store);
    const task = JSON.parse(await readFile(refusalTaskPath, "utf8")) as WorkflowTask;
    const stateRaw = await readFile(refusalStatePath, "utf8");
    const state = JSON.parse(stateRaw) as unknown;
    const effectsRaw = await readFile(refusalEffectsPath, "utf8");
    const verdict = gradeTask(task, state, parseWorkflowEffectLog(effectsRaw));
    expect(verdict.pass).toBe(true);
    const receiptPath = await receiptFor(store, sha256(stateRaw), {
      task_handle: task.task_id,
      task_sha256: sha256(await readFile(refusalTaskPath)),
      business_effect_log_head_sha256: sha256(effectsRaw),
      grader_receipt_sha256: sha256(stableJson(verdict)),
    });

    const bound = await evaluateBranch({
      branchId,
      taskPath: refusalTaskPath,
      candidateStatePath: refusalStatePath,
      effectLogPath: refusalEffectsPath,
      store,
      receiptPath,
    });
    expect(bound.evaluation).toMatchObject({ passed: true, provenance_valid: true });
    expect(bound.evaluation.effect_log_sha256).toBe(sha256(effectsRaw));

    await expect(
      evaluateBranch({ branchId, taskPath: refusalTaskPath, candidateStatePath: refusalStatePath, store, receiptPath }),
    ).rejects.toMatchObject({ code: "BRANCH_RECEIPT_MISMATCH" });
  });
});
