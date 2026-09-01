import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { DalError } from "../../src/errors.js";
import { bindReceiptToState, validateExecutionReceipt } from "../../src/execution-receipt.js";
import { canonicalJson, sha256 } from "../../src/json.js";
import { validateRunRecord } from "../../src/runs.js";

/**
 * Multi-seed pass@k summary: one artifact per batch, one attempt detail per
 * seed. The compare gate pairs two summaries (e.g. g0 vs g1) and requires:
 * same frozen benchmark context, explicit unconfounded candidate/model
 * attribution, same task set, no overall or per-task mean regression, and
 * every receipt still on disk, digest-matching, bound to the graded state, and
 * carrying the required candidate/service/grader isolation evidence.
 */
export interface AttemptDetail {
  attempt: number;
  run_id: string;
  run_record_path: string;
  run_record_sha256: string;
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
  generation: "g0" | "g1" | null;
  candidate_sha256: string;
  benchmark_context_sha256: string;
  transmission_manifest_path: string;
  transmission_manifest_sha256: string;
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
  const model = summary.model as Record<string, unknown> | undefined;
  const overall = summary.overall as Record<string, unknown> | undefined;
  const taskSet = summary.task_set;
  const perTask = summary.per_task;
  const attemptsPerTask = summary.attempts_per_task;
  return (
    summary.format === "e2e-summary-v1" &&
    typeof summary.summary_id === "string" &&
    typeof summary.created_at === "string" &&
    typeof summary.batch === "string" &&
    typeof model === "object" &&
    model !== null &&
    typeof model.provider === "string" &&
    typeof model.model === "string" &&
    (summary.generation === null || summary.generation === "g0" || summary.generation === "g1") &&
    typeof summary.candidate_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(summary.candidate_sha256) &&
    typeof summary.benchmark_context_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(summary.benchmark_context_sha256) &&
    typeof summary.transmission_manifest_path === "string" &&
    typeof summary.transmission_manifest_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(summary.transmission_manifest_sha256) &&
    typeof summary.runner === "string" &&
    (summary.faults === null || typeof summary.faults === "string") &&
    (summary.resolutions === undefined || summary.resolutions === null || typeof summary.resolutions === "string") &&
    typeof attemptsPerTask === "number" &&
    Number.isInteger(attemptsPerTask) &&
    attemptsPerTask > 0 &&
    Array.isArray(taskSet) &&
    taskSet.every((taskId) => typeof taskId === "string") &&
    new Set(taskSet).size === taskSet.length &&
    Array.isArray(perTask) &&
    canonicalJson(perTask.map((entry) => (entry as Record<string, unknown>)?.task_id)) === canonicalJson(taskSet) &&
    typeof overall === "object" &&
    overall !== null &&
    typeof overall.mean_success_rate === "number" &&
    Number.isFinite(overall.mean_success_rate) &&
    typeof overall.pass_at_1 === "number" &&
    Number.isFinite(overall.pass_at_1) &&
    typeof overall.checkpoint_rate === "number" &&
    Number.isFinite(overall.checkpoint_rate) &&
    typeof overall.variance === "number" &&
    Number.isFinite(overall.variance) &&
    perTask.every((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const task = entry as Record<string, unknown>;
      return (
        typeof task.task_id === "string" &&
        task.attempts === attemptsPerTask &&
        typeof task.passed === "number" &&
        Number.isInteger(task.passed) &&
        task.passed >= 0 &&
        task.passed <= attemptsPerTask &&
        typeof task.mean === "number" &&
        Number.isFinite(task.mean) &&
        typeof task.pass_at_1 === "boolean" &&
        typeof task.checkpoint_pass === "boolean" &&
        Array.isArray(task.attempts_detail) &&
        task.attempts_detail.length === attemptsPerTask &&
        task.attempts_detail.every((entryDetail) => {
          if (entryDetail === null || typeof entryDetail !== "object" || Array.isArray(entryDetail)) return false;
          const detail = entryDetail as Record<string, unknown>;
          return (
            typeof detail.attempt === "number" &&
            Number.isInteger(detail.attempt) &&
            detail.attempt >= 1 &&
            detail.attempt <= attemptsPerTask &&
            typeof detail.run_id === "string" &&
            typeof detail.run_record_path === "string" &&
            typeof detail.run_record_sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(detail.run_record_sha256) &&
            typeof detail.receipt_path === "string" &&
            typeof detail.receipt_sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(detail.receipt_sha256) &&
            typeof detail.state_sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(detail.state_sha256) &&
            typeof detail.passed === "boolean"
          );
        })
      );
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

function evidencePath(repoRoot: string, path: string): string | null {
  const root = resolve(repoRoot);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : absolute;
}

async function verifySummaryManifest(
  summary: E2eSummary,
  repoRoot: string,
): Promise<{ manifest: Record<string, unknown> | null; failures: string[] }> {
  const failures: string[] = [];
  const path = evidencePath(repoRoot, summary.transmission_manifest_path);
  if (path === null) {
    return { manifest: null, failures: ["transmission manifest path escapes the repository"] };
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest is not an object");
    manifest = parsed as Record<string, unknown>;
  } catch {
    return { manifest: null, failures: [`transmission manifest missing or invalid at ${summary.transmission_manifest_path}`] };
  }
  if (sha256(canonicalJson(manifest)) !== summary.transmission_manifest_sha256) {
    failures.push("transmission manifest digest mismatch");
  }
  if (manifest.benchmark_context_sha256 !== summary.benchmark_context_sha256) {
    failures.push("summary benchmark context is not bound to its transmission manifest");
  }
  if (manifest.skill_sha256 !== summary.candidate_sha256) {
    failures.push("summary candidate digest is not bound to its transmission manifest");
  }
  const manifestModel = manifest.provider === summary.model.provider && manifest.model === summary.model.model;
  if (!manifestModel) {
    failures.push("summary model is not bound to its transmission manifest");
  }
  if ((manifest.generation ?? null) !== summary.generation) {
    failures.push("summary generation is not bound to its transmission manifest");
  }
  if (manifest.attempts_per_task !== summary.attempts_per_task) {
    failures.push("summary rollout count is not bound to its transmission manifest");
  }
  if (typeof manifest.container_image_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.container_image_sha256)) {
    failures.push("transmission manifest does not bind an immutable container image");
  }
  if (manifest.runner !== summary.runner || manifest.faults !== summary.faults || (manifest.resolutions ?? null) !== (summary.resolutions ?? null)) {
    failures.push("summary runner or fault profile is not bound to its transmission manifest");
  }
  const evaluatorTaskIds = Array.isArray(manifest.evaluator_tasks)
    ? manifest.evaluator_tasks.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const taskId = (entry as Record<string, unknown>).task_id;
      return typeof taskId === "string" ? [taskId] : [];
    })
    : [];
  if (canonicalJson(evaluatorTaskIds) !== canonicalJson(summary.task_set)) {
    failures.push("summary task set is not bound to its transmission manifest");
  }
  return { manifest, failures };
}

export async function verifyReceipts(
  summary: E2eSummary,
  repoRoot: string,
): Promise<{ checked: number; failures: string[] }> {
  let checked = 0;
  const failures: string[] = [];
  const runIds = new Set<string>();
  const receiptPaths = new Set<string>();
  const receiptDigests = new Set<string>();
  const receiptIds = new Set<string>();
  const runRecordPaths = new Set<string>();
  const runRecordDigests = new Set<string>();
  const manifestVerification = await verifySummaryManifest(summary, repoRoot);
  failures.push(...manifestVerification.failures);
  for (const task of summary.per_task) {
    for (const detail of task.attempts_detail) {
      if (runIds.has(detail.run_id)) {
        failures.push(`${detail.run_id}: duplicate run id in summary`);
      }
      runIds.add(detail.run_id);
      if (receiptPaths.has(detail.receipt_path) || receiptDigests.has(detail.receipt_sha256)) {
        failures.push(`${detail.run_id}: receipt evidence is reused by multiple attempts`);
      }
      receiptPaths.add(detail.receipt_path);
      receiptDigests.add(detail.receipt_sha256);
      if (runRecordPaths.has(detail.run_record_path) || runRecordDigests.has(detail.run_record_sha256)) {
        failures.push(`${detail.run_id}: run-record evidence is reused by multiple attempts`);
      }
      runRecordPaths.add(detail.run_record_path);
      runRecordDigests.add(detail.run_record_sha256);
      let raw: Buffer;
      const receiptPath = evidencePath(repoRoot, detail.receipt_path);
      if (receiptPath === null) {
        failures.push(`${detail.run_id}: receipt path escapes the repository`);
        continue;
      }
      try {
        raw = await readFile(receiptPath);
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
        if (receiptIds.has(receipt.receipt_id)) {
          failures.push(`${detail.run_id}: duplicate receipt id in summary`);
        }
        receiptIds.add(receipt.receipt_id);
        if (receipt.run_id !== detail.run_id) {
          failures.push(`${detail.run_id}: receipt run id does not match the summary attempt`);
        }
        if (receipt.task_handle !== task.task_id) {
          failures.push(`${detail.run_id}: receipt task does not match the summary task`);
        }
        if (receipt.candidate_sha256 !== summary.candidate_sha256) {
          failures.push(`${detail.run_id}: receipt candidate does not match the summary candidate`);
        }
        if (receipt.model.provider !== summary.model.provider || receipt.model.model !== summary.model.model) {
          failures.push(`${detail.run_id}: receipt model does not match the summary model`);
        }
        if (receipt.candidate_generation_id !== summary.generation) {
          failures.push(`${detail.run_id}: receipt generation does not match the summary generation`);
        }
        if (receipt.transmission_manifest_sha256 !== summary.transmission_manifest_sha256) {
          failures.push(`${detail.run_id}: receipt is not bound to the summary transmission manifest`);
        }
        const receiptPassed = receipt.business_outcome?.status === "passed";
        if (
          (receipt.business_outcome?.status !== "passed" && receipt.business_outcome?.status !== "failed") ||
          receiptPassed !== detail.passed
        ) {
          failures.push(`${detail.run_id}: receipt business outcome does not match the summary attempt`);
        }
        if (
          manifestVerification.manifest !== null &&
          (typeof manifestVerification.manifest.container_image_sha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(manifestVerification.manifest.container_image_sha256) ||
            typeof receipt.container_image_sha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(receipt.container_image_sha256) ||
            receipt.container_image_sha256 !== manifestVerification.manifest.container_image_sha256)
        ) {
          failures.push(`${detail.run_id}: receipt image does not match the transmission manifest`);
        }
        if (
          receipt.isolation?.topology !== "candidate-service-grader-v1" ||
          receipt.isolation.candidate_workspace_read_only !== true ||
          receipt.isolation.candidate_repository_mounted !== false ||
          receipt.isolation.service_state_access !== "typed-endpoint-only" ||
          receipt.isolation.oracle_access !== "grader-only"
        ) {
          failures.push(`${detail.run_id}: receipt does not prove candidate-service-grader-v1 isolation`);
        }
      } catch (error) {
        const code = error instanceof DalError ? `${error.code}: ` : "";
        failures.push(`${detail.run_id}: ${code}${error instanceof Error ? error.message : String(error)}`);
      }

      const runRecordPath = evidencePath(repoRoot, detail.run_record_path);
      if (runRecordPath === null) {
        failures.push(`${detail.run_id}: run-record path escapes the repository`);
        continue;
      }
      try {
        const runRaw = await readFile(runRecordPath);
        if (sha256(runRaw.toString("utf8")) !== detail.run_record_sha256) {
          failures.push(`${detail.run_id}: run-record file digest mismatch`);
        }
        const run = await validateRunRecord(JSON.parse(runRaw.toString("utf8")) as unknown, runRaw.toString("utf8"));
        if (run.run_id !== detail.run_id) failures.push(`${detail.run_id}: run record id does not match the summary attempt`);
        if (run.task_id !== task.task_id) failures.push(`${detail.run_id}: run-record task does not match the summary task`);
        if (run.outcome !== "succeeded") failures.push(`${detail.run_id}: e2e run record did not complete successfully`);
        const runPassed = run.business_outcome?.status === "passed";
        if (
          (run.business_outcome?.status !== "passed" && run.business_outcome?.status !== "failed") ||
          runPassed !== detail.passed
        ) {
          failures.push(`${detail.run_id}: run-record business outcome does not match the summary attempt`);
        }
        if (run.context.model?.id !== summary.model.model || run.context.model.version !== summary.model.provider) {
          failures.push(`${detail.run_id}: run-record model does not match the summary model`);
        }
        const skillPin = run.context.harness_pins?.find((pin) => pin.surface === "skills");
        if (skillPin?.sha256 !== summary.candidate_sha256) {
          failures.push(`${detail.run_id}: run-record candidate does not match the summary candidate`);
        }
        const expectedReceiptEvidence = `repo://${detail.receipt_path.replaceAll("\\", "/")}`;
        if (!run.evidence.includes(expectedReceiptEvidence)) {
          failures.push(`${detail.run_id}: run record does not reference the bound receipt`);
        }
      } catch (error) {
        const code = error instanceof DalError ? `${error.code}: ` : "";
        failures.push(`${detail.run_id}: ${code}${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { checked, failures };
}

function verifySummaryMetrics(summary: E2eSummary): string[] {
  const failures: string[] = [];
  const epsilon = 1e-9;
  const outcomes: number[] = [];
  for (const task of summary.per_task) {
    const attempts = task.attempts_detail;
    const attemptNumbers = attempts.map((detail) => detail.attempt);
    if (new Set(attemptNumbers).size !== attempts.length || attemptNumbers.some((attempt) => attempt < 1 || attempt > task.attempts)) {
      failures.push(`${task.task_id}: attempt numbers are not unique and in range`);
    }
    const passed = attempts.filter((detail) => detail.passed).length;
    const mean = task.attempts === 0 ? 0 : passed / task.attempts;
    const passAt1 = attempts.find((detail) => detail.attempt === 1)?.passed ?? false;
    const checkpointPass = passed > 0;
    if (
      attempts.length !== task.attempts ||
      task.attempts !== summary.attempts_per_task ||
      task.passed !== passed ||
      Math.abs(task.mean - mean) > epsilon ||
      task.pass_at_1 !== passAt1 ||
      task.checkpoint_pass !== checkpointPass
    ) {
      failures.push(`${task.task_id}: task metrics do not match attempt details`);
    }
    outcomes.push(...attempts.map((detail) => (detail.passed ? 1 : 0)));
  }
  const mean = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const meanOfSquares = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value * value, 0) / outcomes.length;
  const passAt1 = summary.per_task.length === 0 ? 0 : summary.per_task.filter((task) => task.pass_at_1).length / summary.per_task.length;
  const checkpointRate = summary.per_task.length === 0 ? 0 : summary.per_task.filter((task) => task.checkpoint_pass).length / summary.per_task.length;
  if (
    Math.abs(summary.overall.mean_success_rate - mean) > epsilon ||
    Math.abs(summary.overall.pass_at_1 - passAt1) > epsilon ||
    Math.abs(summary.overall.checkpoint_rate - checkpointRate) > epsilon ||
    Math.abs(summary.overall.variance - (meanOfSquares - mean * mean)) > epsilon
  ) {
    failures.push("overall metrics do not match attempt details");
  }
  return failures;
}

export async function compareGate(
  current: E2eSummary,
  reference: E2eSummary,
  repoRoot: string,
): Promise<{ pass: boolean; problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  const epsilon = 1e-9;

  problems.push(...verifySummaryMetrics(current).map((failure) => `current summary: ${failure}`));
  problems.push(...verifySummaryMetrics(reference).map((failure) => `reference summary: ${failure}`));

  if (current.runner !== "docker" || reference.runner !== "docker") {
    problems.push("both summaries must use the isolated docker runner");
  }

  if (current.benchmark_context_sha256 !== reference.benchmark_context_sha256) {
    problems.push("benchmark context mismatch: tasks, evaluator inputs, faults, attempts, image, tools, policy, prompts, or driver source changed");
  }

  const candidateChanged = current.candidate_sha256 !== reference.candidate_sha256;
  const modelChanged = current.model.provider !== reference.model.provider || current.model.model !== reference.model.model;
  if (candidateChanged) {
    if (current.generation === null || reference.generation === null || current.generation === reference.generation) {
      problems.push("candidate digest changed without two distinct explicit generation labels");
    }
    if (modelChanged) {
      problems.push("candidate and model changed together; improvement attribution is confounded");
    }
  } else if (current.generation !== reference.generation) {
    problems.push("identical candidate digests must use the same generation label");
  }

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
  notes.push(receiptFailures.length === 0 ? `receipts valid ${checked}/${checked}` : `receipts checked ${checked}; evidence failures ${receiptFailures.length}`);

  return { pass: problems.length === 0, problems, notes };
}
