import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { recordBranch, evaluateBranch } from "../src/branch.js";
import { validateExecutionReceipt } from "../src/execution-receipt.js";
import { sha256 } from "../src/json.js";
import { gradeTask, stableJson, type WorkflowTask } from "../src/workflow-grader.js";

const repoRoot = resolve(import.meta.dirname, "..");
const workspace = resolve(repoRoot, "benchmarks", "tau-style-workflow");
const taskPath = resolve(workspace, "tasks", "task-001-refund.json");
const statePath = resolve(workspace, "dal", "fixtures", "result-pass.json");

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
  const recorded = await recordBranch({ branchId: `brn-receipt-${randomUUID().slice(0, 8)}`, parentBranchId: null, draftPath, store });
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
    candidate_sha256: "c".repeat(64),
    base_generation_id: "g0",
    candidate_generation_id: "g1",
    effective_composition_sha256: "d".repeat(64),
    task_handle: "task-001-refund",
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    model_patch_sha256: "e".repeat(64),
    dsh_session_id: "session-42",
    event_log_head_sha256: "f".repeat(64),
    business_effect_log_head_sha256: "2".repeat(64),
    container_image_sha256: "3".repeat(64),
    external_state_before_sha256: "0".repeat(64),
    external_state_after_sha256: afterSha,
    grader_receipt_sha256: sha256(stableJson(verdict)),
    source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
    business_outcome: { status: "passed", source: "repo://benchmarks/tau-style-workflow/grader/grade.ts", score: 1, earned: 3, total: 3 },
    ...overrides,
  };
  const path = join(store, "receipt.json");
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

describe("execution receipts (audit P0-2)", () => {
  it("validates the receipt chain schema", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-receipt-"));
    const stateDigest = sha256(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
    const receipt = JSON.parse(await (await import("node:fs/promises")).readFile(await receiptFor(store, stateDigest), "utf8")) as unknown;
    await expect(validateExecutionReceipt(receipt)).resolves.toBeDefined();
    const broken = { ...(receipt as Record<string, unknown>), external_state_after_sha256: "zz" };
    await expect(validateExecutionReceipt(broken)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
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
});
