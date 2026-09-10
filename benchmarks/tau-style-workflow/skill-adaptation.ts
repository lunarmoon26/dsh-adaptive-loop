import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { canonicalJson, publishJsonExclusive, sha256 } from "../../src/json.js";
import { compareGate, readSummary, type E2eSummary } from "./e2e-summary.js";

export const DEVELOPMENT_TASKS = ["task-004-partial-refund.json"] as const;
export const TRANSFER_TASKS = ["task-001-refund.json", "task-002-booking-change.json"] as const;
export const REGRESSION_TASKS = ["task-003-policy-refusal.json", "task-005-booking-refusal.json"] as const;
export const HELD_OUT_TASKS = [...TRANSFER_TASKS, ...REGRESSION_TASKS] as const;
export const PARTITIONS = { development: DEVELOPMENT_TASKS, "held-out": HELD_OUT_TASKS } as const;
export const FAULT_PROFILES = {
  development: { faults: "issue_refund=unknown", resolutions: "issue_refund=success" },
  "held-out": {
    faults: "issue_refund=unknown,change_booking=unknown",
    resolutions: "issue_refund=success,change_booking=success",
  },
} as const;
export type Partition = keyof typeof PARTITIONS;

interface AdaptationReport {
  change_id: "chg-dal-skill-adaptation-slice-20260910";
  status: "rejected" | "eligible_for_proposal" | "no_change_needed" | "improved" | "no_improvement";
  eligible: boolean;
  partition: Partition;
  expected_cases: readonly string[];
  evaluated_cases: string[];
  improvement_scope: "evaluated_cases";
  limited_claim: string;
  promotion_authorized: false;
  next_step: string;
  problems: string[];
  evidence: Array<{
    summary_path: string;
    manifest_path: string;
    manifest_sha256: string;
    attempts: Array<{
      task_id: string;
      receipt_path: string;
      receipt_sha256: string;
      run_record_path: string;
      run_record_sha256: string;
      source: string;
      business_outcome_source: string;
    }>;
  }>;
  mean_delta?: number;
  partition_deltas?: Partial<Record<"development" | "transfer" | "regression", number>>;
}

// This is an experiment filter, not another grader or receipt-validation framework.
async function checkExperiment(summary: E2eSummary, repoRoot: string, partition: Partition): Promise<string[]> {
  const problems: string[] = [];
  if (canonicalJson([...summary.task_set].sort()) !== canonicalJson([...PARTITIONS[partition]].sort())) {
    problems.push(`Expected the exact ${partition} task set`);
  }
  for (const key of ["faults", "resolutions"] as const) {
    if (canonicalJson((summary[key] ?? "").split(",").sort()) !== canonicalJson(FAULT_PROFILES[partition][key].split(",").sort())) {
      problems.push(`Unexpected ${partition} ${key}`);
    }
  }
  const path = resolve(repoRoot, summary.transmission_manifest_path);
  const rel = relative(resolve(repoRoot), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [...problems, "Manifest path escapes repository"];
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (sha256(canonicalJson(manifest)) !== summary.transmission_manifest_sha256) problems.push("Manifest digest mismatch");
    if (manifest?.mode !== "live") problems.push("Bound transmission manifest must declare mode live");
  } catch {
    problems.push("Manifest unavailable or invalid");
  }
  return problems;
}

async function reportEvidence(summary: E2eSummary, summaryPath: string, repoRoot: string): Promise<AdaptationReport["evidence"][number]> {
  const attempts: AdaptationReport["evidence"][number]["attempts"] = [];
  for (const task of summary.per_task) {
    for (const detail of task.attempts_detail) {
      const raw = await readFile(resolve(repoRoot, detail.receipt_path), "utf8");
      if (sha256(raw) !== detail.receipt_sha256) throw new Error("Receipt changed during reporting");
      const receipt = JSON.parse(raw) as { source: string; business_outcome: { source: string } };
      attempts.push({
        task_id: task.task_id,
        receipt_path: detail.receipt_path, receipt_sha256: detail.receipt_sha256,
        run_record_path: detail.run_record_path, run_record_sha256: detail.run_record_sha256,
        source: receipt.source, business_outcome_source: receipt.business_outcome.source,
      });
    }
  }
  return {
    summary_path: summaryPath, manifest_path: summary.transmission_manifest_path,
    manifest_sha256: summary.transmission_manifest_sha256, attempts,
  };
}

function emptyReport(partition: Partition): AdaptationReport {
  return {
    change_id: "chg-dal-skill-adaptation-slice-20260910", status: "rejected", eligible: false,
    partition, expected_cases: PARTITIONS[partition], evaluated_cases: [],
    improvement_scope: "evaluated_cases", promotion_authorized: false,
    limited_claim: "Local receipt and digest validation only; declared live mode is not independent execution attestation. Synthetic validator fixtures are not model improvement. Any observed gain is preliminary evidence for evaluated cases only, not reliability or private-benchmark evidence.",
    next_step: "Resolve evidence or experiment-context problems before drawing conclusions; do not manufacture a baseline failure.",
    problems: [], evidence: [],
  };
}

export async function assessDevelopmentBaseline(summaryPath: string, repoRoot: string): Promise<AdaptationReport> {
  const report = emptyReport("development");
  report.limited_claim += " Baseline self-comparison only reuses existing metric and receipt validation of one batch; it is not two trials or an improvement comparison.";
  try {
    const summary = await readSummary(summaryPath);
    const gate = await compareGate(summary, summary, repoRoot);
    report.problems = [...gate.problems, ...await checkExperiment(summary, repoRoot, "development")];
    if (summary.generation !== "g0") report.problems.push("Development baseline must be generation g0");
    if (report.problems.length) return report;
    report.evidence = [await reportEvidence(summary, summaryPath, repoRoot)];
    report.evaluated_cases = [...summary.task_set];
    report.eligible = summary.per_task.some(task => task.passed < task.attempts);
    report.status = report.eligible ? "eligible_for_proposal" : "no_change_needed";
    report.next_step = report.eligible
      ? "Review the actual development failure against the unchanged production-like skill; prepare a bounded proposal using development evidence only. Any model call needs separate exact approval."
      : "Keep the baseline skill unchanged. Do not weaken instructions or the task to manufacture a failure.";
  } catch {
    report.problems.push("Summary or bound evidence unavailable, invalid, or changed during reporting");
  }
  return report;
}

export async function compareSkillAdaptation(candidatePath: string, baselinePath: string, repoRoot: string, partition: Partition = "held-out"): Promise<AdaptationReport> {
  const report = emptyReport(partition);
  try {
    const baseline = await readSummary(baselinePath);
    const candidate = await readSummary(candidatePath);
    const gate = await compareGate(candidate, baseline, repoRoot);
    report.problems = [...gate.problems,
      ...await checkExperiment(baseline, repoRoot, partition), ...await checkExperiment(candidate, repoRoot, partition)];
    if (baseline.generation !== "g0" || candidate.generation !== "g1") report.problems.push("Comparison requires generations g0 -> g1");
    if (baseline.candidate_sha256 === candidate.candidate_sha256) report.problems.push("Comparison requires distinct candidate digests");
    if (baseline.model.provider !== candidate.model.provider || baseline.model.model !== candidate.model.model) report.problems.push("Provider/model change confounds skill attribution");
    if (baseline.attempts_per_task !== candidate.attempts_per_task) report.problems.push("Rollout budget changed");
    if (report.problems.length) return report;
    report.evidence = [await reportEvidence(baseline, baselinePath, repoRoot), await reportEvidence(candidate, candidatePath, repoRoot)];
    report.evaluated_cases = [...candidate.task_set];
    // Derive the delta from verified outcomes, not rounded summary means that
    // the existing gate accepts within its numeric tolerance.
    report.mean_delta = candidate.per_task.reduce((sum, task) => sum + task.passed, 0) / (candidate.task_set.length * candidate.attempts_per_task)
      - baseline.per_task.reduce((sum, task) => sum + task.passed, 0) / (baseline.task_set.length * baseline.attempts_per_task);
    report.partition_deltas = {};
    const groups: Partial<Record<"development" | "transfer" | "regression", readonly string[]>> = partition === "development" ? { development: DEVELOPMENT_TASKS } : { transfer: TRANSFER_TASKS, regression: REGRESSION_TASKS };
    for (const [name, tasks] of Object.entries(groups)) {
      report.partition_deltas[name as keyof NonNullable<AdaptationReport["partition_deltas"]>] = tasks.reduce((sum, id) =>
        sum + candidate.per_task.find(task => task.task_id === id)!.passed / candidate.attempts_per_task
          - baseline.per_task.find(task => task.task_id === id)!.passed / baseline.attempts_per_task, 0) / tasks.length;
    }
    report.status = report.mean_delta > 0 ? "improved" : "no_improvement";
    report.next_step = report.status === "no_improvement"
      ? "Do not claim a gain or promote the candidate; equality is not improvement."
      : partition === "development"
        ? "Keep the candidate fixed and evaluate the preselected held-out transfer and regression cases under separately approved runs."
        : "Review the limited observed deltas and development baseline eligibility together; this report authorizes no promotion or further paid runs.";
  } catch {
    report.problems.push("Summary or bound evidence unavailable, invalid, or changed during reporting");
  }
  return report;
}

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: {
      baseline: { type: "string" }, candidate: { type: "string" }, partition: { type: "string" }, output: { type: "string" },
    }, strict: true, allowPositionals: false });
    if (!values.baseline || (values.partition !== undefined && values.partition !== "development" && values.partition !== "held-out")) {
      throw new Error("Expected --baseline <summary> [--candidate <summary>] [--partition development|held-out] [--output <new-file>]");
    }
    if (!values.candidate && values.partition === "held-out") throw new Error("Baseline-only assessment requires development partition");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const report = values.candidate
      ? await compareSkillAdaptation(values.candidate, values.baseline, root, values.partition as Partition | undefined)
      : await assessDevelopmentBaseline(values.baseline, root);
    if (values.output && !await publishJsonExclusive(resolve(values.output), report)) throw new Error("Output already exists; refusing to overwrite");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "rejected") process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ status: "error", promotion_authorized: false, error: "Invalid arguments or output unavailable/conflicting; no evidence was changed. Use --baseline <summary> [--candidate <summary>] [--partition development|held-out] [--output <new-file>]." })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
