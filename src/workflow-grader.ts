import { createHash } from "node:crypto";

/**
 * Deterministic end-state grader for the tau-style workflow task class.
 * Pure core shared by the benchmark workspace CLI and the dal runtime.
 * No model, judge, or network.
 *
 * Verifier contract (adapted from the SaaS-Bench audit, 2026-08-29):
 * - Checks carry an optional `weight` for partial credit (default 1).
 * - Checks may be `gated` on an upstream check: when the upstream fails,
 *   the dependent check is skipped with a `gated.reason` instead of
 *   double-penalizing the same failure. Gated checks are excluded from
 *   both the earned and total weight sums.
 * - The verdict exposes `score = earned / total` over non-gated checks
 *   plus the earned/total pair, while `pass` stays the strict binary:
 *   every non-gated check must pass.
 */

export const GRADER_VERSION = "tau-style-workflow-grader-v1";

export interface WorkflowTask {
  task_id: string;
  domain: string;
  instruction: string;
  initial_state: Record<string, unknown>;
  goal_state: Record<string, unknown>;
  policy_ref: string;
}

export interface GraderCheck {
  id: string;
  pass: boolean;
  detail: string;
  /** Partial-credit weight; defaults to 1 when absent. */
  weight?: number;
  /** Present when the check was skipped because `upstream` failed. */
  gated?: { reason: string; upstream: string };
}

export interface Verdict {
  task_id: string;
  pass: boolean;
  checks: GraderCheck[];
  state_digest: string;
  grader_version: string;
  /** Weighted partial credit over non-gated checks: earned / total. */
  score: number;
  earned: number;
  total: number;
}

const REFUND_POLICY_CHECKS = [
  "policy:refund-unknown-order",
  "policy:refund-exceeds-total",
  "policy:full-refund-requires-label",
  "policy:partial-refund-requires-reason",
] as const;

export function gradeTask(task: WorkflowTask, state: unknown): Verdict {
  const checks: GraderCheck[] = [];
  const goal = task.goal_state as Record<string, unknown>;
  const actual = (state ?? {}) as Record<string, unknown>;

  for (const [key, expected] of Object.entries(goal)) {
    const same = deepEqual(actual[key], expected);
    checks.push({
      id: `goal:${key}`,
      pass: same,
      detail: same ? "state matches the annotated goal" : "state does not match the annotated goal",
    });
  }

  const refundsGoalFailed = checks.some((check) => check.id === "goal:refunds" && !check.pass);
  const orders = (actual.orders ?? {}) as Record<string, { total?: number; status?: string }>;
  const initialOrders = (task.initial_state.orders ?? {}) as Record<string, { total?: number; status?: string }>;
  const refunds = (actual.refunds ?? []) as Array<{ order?: string; amount?: number; reason?: string }>;
  const labels = (actual.labels ?? []) as Array<{ order?: string }>;
  for (const refund of refunds) {
    const order = refund.order === undefined ? undefined : orders[refund.order];
    if (refund.order === undefined || order === undefined) {
      checks.push(policyCheck("policy:refund-unknown-order", refundsGoalFailed, "refund references an unknown order"));
      continue;
    }
    const total = order.total ?? initialOrders[refund.order]?.total ?? 0;
    const amount = refund.amount ?? 0;
    if (amount > total) {
      checks.push(policyCheck("policy:refund-exceeds-total", refundsGoalFailed, "refund amount exceeds the order total"));
    }
    if (amount === total && total > 0 && !labels.some((label) => label.order === refund.order)) {
      checks.push(policyCheck("policy:full-refund-requires-label", refundsGoalFailed, "full refunds require a return label"));
    }
    if (amount < total && amount > 0 && (refund.reason ?? "") === "") {
      checks.push(policyCheck("policy:partial-refund-requires-reason", refundsGoalFailed, "partial refunds require a reason code"));
    }
  }
  if (checks.length === 0) {
    checks.push({ id: "goal:empty", pass: false, detail: "task declares no goal state" });
  }

  const scored = aggregate(checks);
  return {
    task_id: task.task_id,
    pass: checks.every((check) => check.pass || check.gated !== undefined),
    checks,
    state_digest: sha256(stableJson(state)),
    grader_version: GRADER_VERSION,
    ...scored,
  };
}

function policyCheck(id: (typeof REFUND_POLICY_CHECKS)[number], gated: boolean, detail: string): GraderCheck {
  if (!gated) {
    return { id, pass: false, detail };
  }
  return { id, pass: false, detail, gated: { reason: detail, upstream: "goal:refunds" } };
}

/** Weighted partial credit over non-gated checks. */
export function aggregate(checks: GraderCheck[]): { score: number; earned: number; total: number } {
  let earned = 0;
  let total = 0;
  for (const check of checks) {
    if (check.gated !== undefined) {
      continue;
    }
    const weight = Math.max(0, check.weight ?? 1);
    total += weight;
    if (check.pass) {
      earned += weight;
    }
  }
  return { score: total === 0 ? 0 : earned / total, earned, total };
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    return keys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

export function stableJson(value: unknown): string {
  const serialize = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.map(serialize);
    }
    const record = entry as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      ordered[key] = serialize(record[key]);
    }
    return ordered;
  };
  return JSON.stringify(serialize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
