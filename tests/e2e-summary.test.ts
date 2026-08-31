import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareGate, isE2eSummary, readSummary, type E2eSummary, type TaskSummary } from "../benchmarks/tau-style-workflow/e2e-summary.js";
import { sha256 } from "../src/json.js";

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

function summaryFor(batch: string, tasks: TaskSummary[]): E2eSummary {
  const outcomes: number[] = tasks.flatMap((task) => task.attempts_detail.map((detail) => (detail.passed ? 1 : 0)));
  const mean = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const meanOfSquares = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value * value, 0) / outcomes.length;
  return {
    format: "e2e-summary-v1",
    summary_id: `esm-${batch}-00000000`,
    created_at: "2026-08-30T00:00:00.000Z",
    batch,
    task_set: tasks.map((task) => task.task_id),
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    runner: "docker",
    faults: null,
    attempts_per_task: tasks[0]?.attempts ?? 1,
    per_task: tasks,
    overall: {
      mean_success_rate: mean,
      pass_at_1: tasks.filter((task) => task.pass_at_1).length / tasks.length,
      checkpoint_rate: tasks.filter((task) => task.checkpoint_pass).length / tasks.length,
      variance: meanOfSquares - mean * mean,
    },
  };
}

async function receiptFor(directory: string, receiptId: string, afterSha: string): Promise<{ path: string; digest: string }> {
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: receiptId,
    created_at: "2026-08-30T00:10:00.000Z",
    candidate_sha256: "c".repeat(64),
    base_generation_id: "g0",
    candidate_generation_id: "g1",
    effective_composition_sha256: "d".repeat(64),
    task_handle: "task-001-refund",
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    model_patch_sha256: "e".repeat(64),
    dsh_session_id: null,
    event_log_head_sha256: null,
    external_state_before_sha256: "0".repeat(64),
    external_state_after_sha256: afterSha,
    grader_receipt_sha256: "1".repeat(64),
    source: "repo://tests/e2e-summary.test.ts",
    business_outcome: { status: "passed", source: "repo://tests/e2e-summary.test.ts", score: 1, earned: 1, total: 1 },
  };
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  const path = join(directory, `${receiptId}.json`);
  await writeFile(path, raw, "utf8");
  return { path, digest: sha256(raw) };
}

const cleanups: string[] = [];

afterEach(async () => {
  for (const directory of cleanups.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("e2e pass@k summary and compare gate", () => {
  it("validates the summary artifact shape", async () => {
    const detail = { attempt: 1, run_id: "run-00000001", receipt_path: "receipts/x.json", receipt_sha256: "f".repeat(64), state_sha256: "a".repeat(64), passed: true };
    const summary = summaryFor("g0", [taskSummary("a.json", 1, 1, [detail])]);
    expect(isE2eSummary(summary)).toBe(true);
    expect(isE2eSummary({ ...summary, format: "other" })).toBe(false);
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

    const g0a = await receiptFor(receiptsDir, "rcp-g0-00000001", "a".repeat(64));
    const g0b = await receiptFor(receiptsDir, "rcp-g0-00000002", "a".repeat(64));
    const g1a = await receiptFor(receiptsDir, "rcp-g1-00000001", "a".repeat(64));
    const g1b = await receiptFor(receiptsDir, "rcp-g1-00000002", "a".repeat(64));
    const detail = (receiptPath: string, digest: string, attempt: number, passed: boolean) => ({
      attempt,
      run_id: `run-${attempt}`,
      receipt_path: receiptPath,
      receipt_sha256: digest,
      state_sha256: "a".repeat(64),
      passed,
    });
    const g0 = summaryFor("g0", [
      taskSummary("task-a.json", 1, 2, [
        detail(join("receipts", "rcp-g0-00000001.json"), g0a.digest, 1, true),
        detail(join("receipts", "rcp-g0-00000002.json"), g0b.digest, 2, false),
      ]),
    ]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 2, 2, [
        detail(join("receipts", "rcp-g1-00000001.json"), g1a.digest, 1, true),
        detail(join("receipts", "rcp-g1-00000002.json"), g1b.digest, 2, true),
      ]),
    ]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(true);
    expect(gate.problems).toEqual([]);
    expect(gate.notes.join("; ")).toContain("receipts valid 4/4");
  });

  it("fails the gate on an overall mean regression", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const empty = (passed: boolean) => ({ attempt: 1, run_id: "run-00000001", receipt_path: "receipts/missing.json", receipt_sha256: "", state_sha256: "", passed });
    const g0 = summaryFor("g0", [taskSummary("task-a.json", 2, 2, [empty(true), empty(true)])]);
    const g1 = summaryFor("g1", [taskSummary("task-a.json", 1, 2, [empty(true), empty(false)])]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("overall mean regressed");
  });

  it("fails the gate on a per-task regression even when the overall mean holds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-gate-"));
    cleanups.push(directory);
    const empty = (passed: boolean) => ({ attempt: 1, run_id: "run-00000001", receipt_path: "receipts/missing.json", receipt_sha256: "", state_sha256: "", passed });
    const g0 = summaryFor("g0", [
      taskSummary("task-a.json", 0, 2, [empty(false), empty(false)]),
      taskSummary("task-b.json", 2, 2, [empty(true), empty(true)]),
    ]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 1, 2, [empty(true), empty(false)]),
      taskSummary("task-b.json", 1, 2, [empty(true), empty(false)]),
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
    const receipt = await receiptFor(receiptsDir, "rcp-g1-00000001", "a".repeat(64));
    const g0 = summaryFor("g0", [taskSummary("task-a.json", 1, 1, [])]);
    const g1 = summaryFor("g1", [
      taskSummary("task-a.json", 1, 1, [
        { attempt: 1, run_id: "run-00000001", receipt_path: join("receipts", "rcp-g1-00000001.json"), receipt_sha256: receipt.digest, state_sha256: "b".repeat(64), passed: true },
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
    const detail = { attempt: 1, run_id: "run-00000001", receipt_path: "receipts/missing.json", receipt_sha256: "f".repeat(64), state_sha256: "a".repeat(64), passed: true };
    const g1 = summaryFor("g1", [taskSummary("task-a.json", 1, 1, [detail])]);
    const gate = await compareGate(g1, g0, directory);
    expect(gate.pass).toBe(false);
    expect(gate.problems.join("; ")).toContain("receipt file missing");
  });
});
