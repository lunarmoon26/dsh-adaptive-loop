import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bindReceiptToState, validateExecutionReceipt } from "./execution-receipt.js";
import { gradeTask, parseWorkflowEffectLog, stableJson, type WorkflowTask } from "./workflow-grader.js";
import { DalError, isNodeError } from "./errors.js";
import { publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { Policy } from "./types.js";

export interface BranchRecord {
  $schema: string;
  schema_version: "1.0.0";
  branch_id: string;
  parent_branch_id: string | null;
  draft_ref: string;
  draft_sha256: string;
  candidate_artifact_ref?: string;
  candidate_artifact_sha256?: string;
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
  effect_log_ref?: string | null;
  effect_log_sha256?: string | null;
  passed: boolean;
  score: number;
  checks: Array<{ id: string; pass: boolean }>;
  observed_at: string;
  receipt_id?: string | null;
  receipt_sha256?: string | null;
  provenance_valid?: boolean;
  proof_version?: "branch-receipt-v1";
  task_ref?: string;
  task_sha256?: string;
  receipt_ref?: string;
  draft_ref?: string;
  draft_sha256?: string;
  candidate_artifact_ref?: string;
  candidate_artifact_sha256?: string;
  execution_sha256?: string;
  receipt_content_sha256?: string;
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
  candidatePath?: string;
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
  const draftDigest = sha256(draftDocument.raw);

  const branch: BranchRecord = {
    $schema: SCHEMA_IDS.branchRecord,
    schema_version: "1.0.0",
    branch_id: options.branchId,
    parent_branch_id: options.parentBranchId,
    draft_ref: pathToFileURL(resolve(options.draftPath)).href,
    draft_sha256: draftDigest,
    ...(options.candidatePath === undefined ? {} : {
      candidate_artifact_ref: pathToFileURL(resolve(options.candidatePath)).href,
      candidate_artifact_sha256: sha256(await readFile(options.candidatePath)),
    }),
    surface: draft.surface,
    created_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.branchRecord, branch, "Branch record");
  const destination = resolve(store, `${options.branchId}.branch.json`);
  const published = await publishJsonExclusive(destination, branch);
  if (!published) {
    const existing = await readJsonFile<BranchRecord>(destination);
    await assertSchema(SCHEMA_IDS.branchRecord, existing.value, "Branch record");
    if (
      existing.value.parent_branch_id === branch.parent_branch_id &&
      existing.value.draft_sha256 === branch.draft_sha256 &&
      existing.value.draft_ref === branch.draft_ref &&
      existing.value.candidate_artifact_ref === branch.candidate_artifact_ref &&
      existing.value.candidate_artifact_sha256 === branch.candidate_artifact_sha256 &&
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
    const raw = await readFile(resolve(store, `${branchId}.branch.json`), "utf8");
    const branch = JSON.parse(raw) as BranchRecord;
    await assertSchema(SCHEMA_IDS.branchRecord, branch, "Branch record");
    if (branch.branch_id !== branchId) throw new DalError("BRANCH_CONFLICT", "Branch filename and identity differ");
    return branch;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DalError("BRANCH_MISSING", `Branch ${branchId} does not exist`);
    }
    throw error;
  }
}

interface EvaluateOptions {
  branchId: string;
  taskPath: string;
  candidateStatePath: string;
  effectLogPath?: string;
  store?: string;
  receiptPath?: string;
}

async function prepareEvaluation(options: EvaluateOptions, store: string): Promise<BranchEvaluation> {
  const branch = await loadBranch(store, options.branchId);

  const taskDocument = await readJsonFile<WorkflowTask>(options.taskPath);
  const stateDocument = await readJsonFile<unknown>(options.candidateStatePath);
  const stateDigest = sha256(stateDocument.raw);
  const effectLogBytes = options.effectLogPath === undefined ? undefined : await readFile(options.effectLogPath);
  const effectLogRaw = effectLogBytes?.toString("utf8");
  const effectLogDigest = effectLogBytes === undefined ? null : sha256(effectLogBytes);
  const effects = effectLogRaw === undefined ? undefined : parseWorkflowEffectLog(effectLogRaw);
  const verdict = gradeTask(taskDocument.value, stateDocument.value, effects);
  const checks: Array<{ id: string; pass: boolean }> = verdict.checks.map((check) => ({ id: check.id, pass: check.pass }));

  let receiptId: string | null = null;
  let receiptSha: string | null = null;
  let provenanceValid = false;
  let proof: Partial<BranchEvaluation> = {};
  if (options.receiptPath !== undefined) {
    if (!branch.candidate_artifact_ref || !branch.candidate_artifact_sha256) {
      throw new DalError("BRANCH_RECEIPT_MISMATCH", "Branch has no candidate artifact binding");
    }
    for (const [ref, digest] of [[branch.draft_ref, branch.draft_sha256], [branch.candidate_artifact_ref, branch.candidate_artifact_sha256]] as const) {
      if (sha256(await readFile(fileURLToPath(ref))) !== digest) {
        throw new DalError("BRANCH_RECEIPT_MISMATCH", "Branch draft or candidate artifact bytes changed");
      }
    }
    const receiptDocument = await readJsonFile<unknown>(options.receiptPath);
    const receipt = await validateExecutionReceipt(receiptDocument.value);
    bindReceiptToState(receipt, stateDigest);
    if (receipt.candidate_sha256 !== branch.candidate_artifact_sha256 ||
        receipt.task_sha256 !== sha256(taskDocument.raw) ||
        !receipt.base_generation_id?.trim() || !receipt.candidate_generation_id?.trim() ||
        !receipt.dsh_session_id?.trim() || !receipt.model_patch_sha256 ||
        !receipt.event_log_head_sha256 || !receipt.external_state_before_sha256) {
      throw new DalError("BRANCH_RECEIPT_MISMATCH", "Receipt lacks exact candidate, task revision, or execution base binding");
    }
    if (receipt.task_handle !== taskDocument.value.task_id) {
      throw new DalError(
        "BRANCH_RECEIPT_MISMATCH",
        "The execution receipt does not bind this task: its task_handle must equal the graded task id",
        [`receipt: ${receipt.task_handle}`, `task: ${taskDocument.value.task_id}`],
      );
    }
    const hasEffectRules =
      taskDocument.value.effect_requirements.required.length > 0 ||
      taskDocument.value.effect_requirements.forbidden.length > 0;
    if (hasEffectRules && effectLogRaw === undefined) {
      throw new DalError(
        "BRANCH_RECEIPT_MISMATCH",
        "The task has effect requirements, so a receipt-bound evaluation must supply --effects",
      );
    }
    if ((receipt.business_effect_log_head_sha256 ?? null) !== effectLogDigest) {
      throw new DalError(
        "BRANCH_RECEIPT_MISMATCH",
        "The execution receipt does not bind this effect log",
        [`receipt: ${receipt.business_effect_log_head_sha256 ?? "null"}`, `effects: ${effectLogDigest}`],
      );
    }
    const graderReceipt = sha256(stableJson(verdict));
    if (receipt.grader_receipt_sha256 !== graderReceipt) {
      throw new DalError(
        "BRANCH_RECEIPT_MISMATCH",
        "The execution receipt does not bind this verdict: its grader_receipt_sha256 must equal the digest of the graded verdict",
        [`receipt: ${receipt.grader_receipt_sha256}`, `verdict: ${graderReceipt}`],
      );
    }
    receiptId = receipt.receipt_id;
    receiptSha = sha256(receiptDocument.raw);
    provenanceValid = true;
    const { receipt_id: _id, created_at: _time, ...content } = receipt;
    proof = {
      proof_version: "branch-receipt-v1",
      task_ref: pathToFileURL(resolve(options.taskPath)).href,
      task_sha256: sha256(taskDocument.raw),
      receipt_ref: pathToFileURL(resolve(options.receiptPath)).href,
      draft_ref: branch.draft_ref,
      draft_sha256: branch.draft_sha256,
      candidate_artifact_ref: branch.candidate_artifact_ref,
      candidate_artifact_sha256: branch.candidate_artifact_sha256,
      execution_sha256: sha256(stableJson([receipt.dsh_session_id, receipt.task_handle])),
      receipt_content_sha256: sha256(stableJson(content)),
    };
  }

  const evaluation: BranchEvaluation = {
    $schema: SCHEMA_IDS.branchEvaluation,
    schema_version: "1.0.0",
    evaluation_id: `bev-${proof.execution_sha256 ?? randomUUID()}`,
    branch_id: options.branchId,
    task_id: verdict.task_id,
    candidate_ref: pathToFileURL(resolve(options.candidateStatePath)).href,
    candidate_sha256: stateDigest,
    effect_log_ref: options.effectLogPath === undefined ? null : pathToFileURL(resolve(options.effectLogPath)).href,
    effect_log_sha256: effectLogDigest,
    passed: verdict.pass,
    score: verdict.pass ? 1 : 0,
    checks,
    observed_at: new Date().toISOString(),
    receipt_id: receiptId,
    receipt_sha256: receiptSha,
    provenance_valid: provenanceValid,
    ...proof,
  };
  await assertSchema(SCHEMA_IDS.branchEvaluation, evaluation, "Branch evaluation");
  return evaluation;
}

function evaluationBinding(evaluation: BranchEvaluation): string {
  const { observed_at: _time, evaluation_id: _id, ...binding } = evaluation;
  return stableJson(binding);
}

async function storeNames(store: string): Promise<string[]> {
  try {
    return (await readdir(store)).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function verifiedEvaluations(store: string): Promise<BranchEvaluation[]> {
  const identities = new Map<string, BranchEvaluation>();
  const verified: BranchEvaluation[] = [];
  for (const name of (await storeNames(store)).filter((name) => name.endsWith(".evaluation.json"))) {
    const { value } = await readJsonFile<BranchEvaluation>(resolve(store, name));
    await assertSchema(SCHEMA_IDS.branchEvaluation, value, "Branch evaluation");
    if (value.provenance_valid !== true || value.proof_version === undefined) continue;
    if (!value.task_ref || !value.receipt_ref) {
      throw new DalError("BRANCH_RECEIPT_MISMATCH", "Incomplete branch evaluation proof");
    }
    const replay = await prepareEvaluation({
      branchId: value.branch_id,
      taskPath: fileURLToPath(value.task_ref),
      candidateStatePath: fileURLToPath(value.candidate_ref),
      ...(value.effect_log_ref == null ? {} : { effectLogPath: fileURLToPath(value.effect_log_ref) }),
      receiptPath: fileURLToPath(value.receipt_ref),
    }, store);
    if (evaluationBinding(value) !== evaluationBinding(replay) || value.evaluation_id !== replay.evaluation_id) {
      throw new DalError("BRANCH_RECEIPT_MISMATCH", "Stored evaluation does not match its reloaded proof");
    }
    const keys = [`id:${replay.receipt_id}`, `content:${replay.receipt_content_sha256}`, `execution:${replay.execution_sha256}`];
    let duplicate = false;
    for (const key of keys) {
      const previous = identities.get(key);
      if (previous) {
        if (evaluationBinding(previous) !== evaluationBinding(replay)) {
          throw new DalError("BRANCH_EVALUATION_CONFLICT", "Receipt or execution identity reused with different branch/binding");
        }
        duplicate = true;
      }
      identities.set(key, replay);
    }
    if (!duplicate) verified.push(replay);
  }
  return verified;
}

export async function evaluateBranch(options: EvaluateOptions): Promise<{ status: "recorded" | "idempotent"; path: string; evaluation: BranchEvaluation }> {
  const store = branchStore(await loadPolicy(), options.store);
  const evaluation = await prepareEvaluation(options, store);
  if (evaluation.provenance_valid) {
    for (const previous of await verifiedEvaluations(store)) {
      if (previous.receipt_id === evaluation.receipt_id ||
          previous.receipt_content_sha256 === evaluation.receipt_content_sha256 ||
          previous.execution_sha256 === evaluation.execution_sha256) {
        if (evaluationBinding(previous) !== evaluationBinding(evaluation)) {
          throw new DalError("BRANCH_EVALUATION_CONFLICT", "Receipt or execution identity already bound to another evaluation");
        }
      }
    }
  }
  const destination = resolve(store, `${evaluation.evaluation_id}.evaluation.json`);
  const published = await publishJsonExclusive(destination, evaluation);
  if (!published) {
    const existing = await readJsonFile<BranchEvaluation>(destination);
    await assertSchema(SCHEMA_IDS.branchEvaluation, existing.value, "Branch evaluation");
    if (existing.value.evaluation_id === evaluation.evaluation_id && evaluationBinding(existing.value) === evaluationBinding(evaluation)) {
      return { status: "idempotent", path: destination, evaluation: existing.value };
    }
    throw new DalError("BRANCH_EVALUATION_CONFLICT", `Evaluation ${evaluation.evaluation_id} already exists with different content`);
  }
  return { status: "recorded", path: destination, evaluation };
}

export async function branchStats(options: { store?: string } = {}): Promise<BranchStats[]> {
  const policy = await loadPolicy();
  const store = branchStore(policy, options.store);
  const names = (await storeNames(store)).filter((name) => name.endsWith(".branch.json"));
  const evaluations = new Map<string, number[]>();
  for (const evaluation of await verifiedEvaluations(store)) {
    const scores = evaluations.get(evaluation.branch_id) ?? [];
    scores.push(evaluation.score);
    evaluations.set(evaluation.branch_id, scores);
  }
  const stats: BranchStats[] = [];
  for (const name of names) {
    const document = await readJsonFile<BranchRecord>(resolve(store, name));
    await assertSchema(SCHEMA_IDS.branchRecord, document.value, "Branch record");
    if (name !== `${document.value.branch_id}.branch.json`) throw new DalError("BRANCH_CONFLICT", "Branch filename and identity differ");
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
