import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "../../src/errors.js";
import { bindReceiptToState, validateExecutionReceipt } from "../../src/execution-receipt.js";
import { sha256 } from "../../src/json.js";

/**
 * Multi-seed pass@k summary: one artifact per batch, one attempt detail per
 * seed. The compare gate pairs two summaries (e.g. g0 vs g1) and requires:
 * same task set, no overall mean regression, no per-task mean regression,
 * and every receipt still on disk, digest-matching, and bound to the graded
 * state digest.
 */
export interface AttemptDetail {
  attempt: number;
  run_id: string;
  receipt_path: string;
  receipt_sha256: string;
  state_sha256: string;
  passed: boolean;
}

export interface TaskSummary {
  task_id: string;
  attempts: number;
  passed: number;
  mean: number;
  pass_at_1: boolean;
  checkpoint_pass: boolean;
  attempts_detail: AttemptDetail[];
}

export interface E2eSummary {
  format: "e2e-summary-v1";
  summary_id: string;
  created_at: string;
  batch: string;
  task_set: string[];
  model: { provider: string; model: string };
  runner: string;
  faults: string | null;
  resolutions?: string | null;
  attempts_per_task: number;
  per_task: TaskSummary[];
  overall: { mean_success_rate: number; pass_at_1: number; checkpoint_rate: number; variance: number };
}

export function isE2eSummary(value: unknown): value is E2eSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  const overall = summary.overall as Record<string, unknown> | undefined;
  return (
    summary.format === "e2e-summary-v1" &&
    typeof summary.batch === "string" &&
    typeof summary.attempts_per_task === "number" &&
    Array.isArray(summary.task_set) &&
    Array.isArray(summary.per_task) &&
    typeof overall === "object" &&
    overall !== null &&
    typeof overall.mean_success_rate === "number" &&
    summary.per_task.every((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const task = entry as Record<string, unknown>;
      return typeof task.task_id === "string" && typeof task.mean === "number" && Array.isArray(task.attempts_detail);
    })
  );
}

export async function readSummary(path: string): Promise<E2eSummary> {
  const document = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isE2eSummary(document)) {
    throw new Error(`Not a valid e2e-summary-v1 artifact: ${path}`);
  }
  return document;
}

export async function verifyReceipts(
  summary: E2eSummary,
  repoRoot: string,
): Promise<{ checked: number; failures: string[] }> {
  let checked = 0;
  const failures: string[] = [];
  for (const task of summary.per_task) {
    for (const detail of task.attempts_detail) {
      let raw: Buffer;
      try {
        raw = await readFile(resolve(repoRoot, detail.receipt_path));
      } catch {
        failures.push(`${detail.run_id}: receipt file missing at ${detail.receipt_path}`);
        continue;
      }
      checked += 1;
      if (sha256(raw.toString("utf8")) !== detail.receipt_sha256) {
        failures.push(`${detail.run_id}: receipt file digest mismatch`);
      }
      try {
        const receipt = await validateExecutionReceipt(JSON.parse(raw.toString("utf8")) as unknown);
        bindReceiptToState(receipt, detail.state_sha256);
      } catch (error) {
        const code = error instanceof DalError ? `${error.code}: ` : "";
        failures.push(`${detail.run_id}: ${code}${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { checked, failures };
}

export async function compareGate(
  current: E2eSummary,
  reference: E2eSummary,
  repoRoot: string,
): Promise<{ pass: boolean; problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  const epsilon = 1e-9;

  const currentSet = new Set(current.task_set);
  const referenceSet = new Set(reference.task_set);
  const missing = [...referenceSet].filter((id) => !currentSet.has(id));
  const extra = [...currentSet].filter((id) => !referenceSet.has(id));
  if (missing.length > 0 || extra.length > 0) {
    problems.push(`task set mismatch: missing ${missing.join(",")}, extra ${extra.join(",")}`);
  }

  notes.push(`mean ${current.overall.mean_success_rate.toFixed(3)} vs ${reference.overall.mean_success_rate.toFixed(3)}`);
  if (current.overall.mean_success_rate + epsilon < reference.overall.mean_success_rate) {
    problems.push(`overall mean regressed: ${current.overall.mean_success_rate.toFixed(3)} < ${reference.overall.mean_success_rate.toFixed(3)}`);
  }

  const referenceByTask = new Map(reference.per_task.map((entry) => [entry.task_id, entry]));
  const regressed: string[] = [];
  for (const task of current.per_task) {
    const baseline = referenceByTask.get(task.task_id);
    if (baseline !== undefined && task.mean + epsilon < baseline.mean) {
      regressed.push(`${task.task_id} (${task.mean.toFixed(3)} < ${baseline.mean.toFixed(3)})`);
    }
  }
  if (regressed.length > 0) {
    problems.push(`regressed tasks: ${regressed.join("; ")}`);
  }

  const [currentReceipts, referenceReceipts] = await Promise.all([
    verifyReceipts(current, repoRoot),
    verifyReceipts(reference, repoRoot),
  ]);
  const checked = currentReceipts.checked + referenceReceipts.checked;
  const receiptFailures = [...currentReceipts.failures, ...referenceReceipts.failures];
  for (const failure of receiptFailures) {
    problems.push(`receipt: ${failure}`);
  }
  notes.push(`receipts valid ${checked - receiptFailures.length}/${checked}`);

  return { pass: problems.length === 0, problems, notes };
}
