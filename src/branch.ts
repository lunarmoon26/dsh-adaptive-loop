import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { bindReceiptToState, readExecutionReceipt, receiptDigest } from "./execution-receipt.js";
import { gradeTask, type WorkflowTask } from "./workflow-grader.js";
import { DalError } from "./errors.js";
import { prettyJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { Policy } from "./types.js";

export interface BranchRecord {
  $schema: string;
  schema_version: "1.0.0";
  branch_id: string;
  parent_branch_id: string | null;
  draft_ref: string;
  draft_sha256: string;
  surface: string;
  created_at: string;
}

export interface BranchEvaluation {
  $schema: string;
  schema_version: "1.0.0";
  evaluation_id: string;
  branch_id: string;
  task_id: string;
  candidate_ref: string;
  candidate_sha256: string;
  passed: boolean;
  score: number;
  checks: Array<{ id: string; pass: boolean }>;
  observed_at: string;
  receipt_id?: string | null;
  receipt_sha256?: string | null;
  provenance_valid?: boolean;
}

export interface BranchStats {
  branch_id: string;
  visits: number;
  mean_score: number;
  parent_branch_id: string | null;
}

export interface BranchSelectResult {
  selected: string;
  reason: string;
  stats: BranchStats[];
}

function branchStore(policy: Policy, requested?: string): string {
  return resolve(process.cwd(), requested ?? (policy as Policy & { default_branch_store?: string }).default_branch_store ?? ".dal/branches");
}

export async function recordBranch(options: {
  branchId: string;
  parentBranchId: string | null;
  draftPath: string;
  store?: string;
}): Promise<{ status: "recorded" | "idempotent"; path: string; branch: BranchRecord }> {
  const policy = await loadPolicy();
  const store = branchStore(policy, options.store);

  if (options.parentBranchId !== null) {
    await loadBranch(store, options.parentBranchId);
  }

  const draftDocument = await readJsonFile<{ draft_id?: unknown; surface?: unknown }>(options.draftPath);
  await assertSchema(SCHEMA_IDS.proposalDraft, draftDocument.value, "Proposal draft");
  const draft = draftDocument.value as { draft_id: string; surface: string };
  const draftDigest = sha256(draftDocument.raw.toString("utf8"));

  const branch: BranchRecord = {
    $schema: SCHEMA_IDS.branchRecord,
    schema_version: "1.0.0",
    branch_id: options.branchId,
    parent_branch_id: options.parentBranchId,
    draft_ref: "file://" + resolve(process.cwd(), options.draftPath),
    draft_sha256: draftDigest,
    surface: draft.surface,
    created_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.branchRecord, branch, "Branch record");
  const destination = resolve(store, `${options.branchId}.branch.json`);
  const published = await publishJsonExclusive(destination, branch);
  if (!published) {
    const existing = await readJsonFile<BranchRecord>(destination);
    if (
      existing.value.parent_branch_id === branch.parent_branch_id &&
      existing.value.draft_sha256 === branch.draft_sha256 &&
      existing.value.surface === branch.surface
    ) {
      return { status: "idempotent", path: destination, branch: existing.value };
    }
    throw new DalError("BRANCH_CONFLICT", `Branch ${options.branchId} already exists with different content`);
  }
  return { status: "recorded", path: destination, branch };
}

async function loadBranch(store: string, branchId: string): Promise<BranchRecord> {
  try {
    const document = await readJsonFile<unknown>(resolve(store, `${branchId}.branch.json`));
    await assertSchema(SCHEMA_IDS.branchRecord, document.value, "Branch record");
    return document.value as BranchRecord;
  } catch (error) {
    if (error instanceof DalError && error.code === "FILE_READ_FAILED") {
      throw new DalError("BRANCH_MISSING", `Branch ${branchId} does not exist`);
    }
    throw error;
  }
}

export async function evaluateBranch(options: {
  branchId: string;
  taskPath: string;
  candidateStatePath: string;
  store?: string;
  receiptPath?: string;
}): Promise<{ status: "recorded" | "idempotent"; path: string; evaluation: BranchEvaluation }> {
  const policy = await loadPolicy();
  const store = branchStore(policy, options.store);
  await loadBranch(store, options.branchId);

  const taskDocument = await readJsonFile<WorkflowTask>(options.taskPath);
  const stateDocument = await readJsonFile<unknown>(options.candidateStatePath);
  const stateDigest = sha256(stateDocument.raw.toString("utf8"));
  const verdict = gradeTask(taskDocument.value, stateDocument.value);
  const checks: Array<{ id: string; pass: boolean }> = verdict.checks.map((check) => ({ id: check.id, pass: check.pass }));

  // Execution-receipt binding (audit P0-2): a provenance-valid evaluation
  // must carry a receipt that binds this exact graded state.
  let receiptId: string | null = null;
  let receiptSha: string | null = null;
  let provenanceValid = false;
  if (options.receiptPath !== undefined) {
    const receipt = await readExecutionReceipt(options.receiptPath);
    bindReceiptToState(receipt, stateDigest);
    receiptId = receipt.receipt_id;
    receiptSha = receiptDigest(receipt);
    provenanceValid = true;
  }

  const evaluation: BranchEvaluation = {
    $schema: SCHEMA_IDS.branchEvaluation,
    schema_version: "1.0.0",
    evaluation_id: `bev-${randomUUID()}`,
    branch_id: options.branchId,
    task_id: verdict.task_id,
    candidate_ref: "file://" + resolve(process.cwd(), options.candidateStatePath),
    candidate_sha256: stateDigest,
    passed: verdict.pass,
    score: verdict.pass ? 1 : 0,
    checks,
    observed_at: new Date().toISOString(),
    receipt_id: receiptId,
    receipt_sha256: receiptSha,
    provenance_valid: provenanceValid,
  };
  await assertSchema(SCHEMA_IDS.branchEvaluation, evaluation, "Branch evaluation");
  const destination = resolve(store, `${evaluation.evaluation_id}.evaluation.json`);
  const published = await publishJsonExclusive(destination, evaluation);
  if (!published) {
    const existing = await readJsonFile<BranchEvaluation>(destination);
    if (sha256(prettyJson(existing.value)) === sha256(prettyJson(evaluation))) {
      return { status: "idempotent", path: destination, evaluation: existing.value };
    }
    throw new DalError("BRANCH_EVALUATION_CONFLICT", `Evaluation ${evaluation.evaluation_id} already exists with different content`);
  }
  return { status: "recorded", path: destination, evaluation };
}

export async function branchStats(options: { store?: string } = {}): Promise<BranchStats[]> {
  const policy = await loadPolicy();
  const store = branchStore(policy, options.store);
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".branch.json")).sort();
  } catch {
    return [];
  }
  const evaluations = new Map<string, number[]>();
  try {
    for (const name of (await readdir(store)).filter((name) => name.endsWith(".evaluation.json"))) {
      const document = await readJsonFile<BranchEvaluation>(resolve(store, name));
      const scores = evaluations.get(document.value.branch_id) ?? [];
      scores.push(document.value.score);
      evaluations.set(document.value.branch_id, scores);
    }
  } catch {
    // no evaluations yet
  }
  const stats: BranchStats[] = [];
  for (const name of names) {
    const document = await readJsonFile<BranchRecord>(resolve(store, name));
    const scores = evaluations.get(document.value.branch_id) ?? [];
    stats.push({
      branch_id: document.value.branch_id,
      visits: scores.length,
      mean_score: scores.length === 0 ? 0 : scores.reduce((total, score) => total + score, 0) / scores.length,
      parent_branch_id: document.value.parent_branch_id,
    });
  }
  return stats;
}

export function selectBranchUcb(stats: readonly BranchStats[], exploration = 1.4): BranchSelectResult {
  if (stats.length === 0) {
    throw new DalError("BRANCH_EMPTY", "No branches recorded");
  }
  const totalVisits = stats.reduce((total, entry) => total + entry.visits, 0);
  let selected: BranchStats = stats[0]!;
  let bestUcb = Number.NEGATIVE_INFINITY;
  for (const entry of stats) {
    const ucb =
      entry.visits === 0
        ? Number.POSITIVE_INFINITY
        : entry.mean_score + exploration * Math.sqrt(Math.log(totalVisits) / entry.visits);
    if (ucb > bestUcb || (ucb === bestUcb && entry.branch_id < selected.branch_id)) {
      bestUcb = ucb;
      selected = entry;
    }
  }
  return {
    selected: selected.branch_id,
    reason:
      selected.visits === 0
        ? "unexplored branch selected"
        : `UCB1 selected with mean ${selected.mean_score.toFixed(3)} over ${selected.visits} visits`,
    stats: [...stats].sort((left, right) => left.branch_id.localeCompare(right.branch_id)),
  };
}
