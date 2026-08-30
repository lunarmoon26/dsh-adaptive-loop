import { createHash } from "node:crypto";

/**
 * Deterministic end-state grader for the tau-style workflow task class.
 * Pure core shared by the benchmark workspace CLI and the dal runtime.
 * No model, judge, or network.
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
}

export interface Verdict {
  task_id: string;
  pass: boolean;
  checks: GraderCheck[];
  state_digest: string;
  grader_version: string;
}

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

  const orders = (actual.orders ?? {}) as Record<string, { total?: number; status?: string }>;
  const initialOrders = (task.initial_state.orders ?? {}) as Record<string, { total?: number; status?: string }>;
  const refunds = (actual.refunds ?? []) as Array<{ order?: string; amount?: number; reason?: string }>;
  const labels = (actual.labels ?? []) as Array<{ order?: string }>;
  for (const refund of refunds) {
    const order = refund.order === undefined ? undefined : orders[refund.order];
    if (refund.order === undefined || order === undefined) {
      checks.push({ id: "policy:refund-unknown-order", pass: false, detail: "refund references an unknown order" });
      continue;
    }
    const total = order.total ?? initialOrders[refund.order]?.total ?? 0;
    const amount = refund.amount ?? 0;
    if (amount > total) {
      checks.push({ id: "policy:refund-exceeds-total", pass: false, detail: "refund amount exceeds the order total" });
    }
    if (amount === total && total > 0 && !labels.some((label) => label.order === refund.order)) {
      checks.push({ id: "policy:full-refund-requires-label", pass: false, detail: "full refunds require a return label" });
    }
    if (amount < total && amount > 0 && (refund.reason ?? "") === "") {
      checks.push({ id: "policy:partial-refund-requires-reason", pass: false, detail: "partial refunds require a reason code" });
    }
  }
  if (checks.length === 0) {
    checks.push({ id: "goal:empty", pass: false, detail: "task declares no goal state" });
  }

  return {
    task_id: task.task_id,
    pass: checks.every((check) => check.pass),
    checks,
    state_digest: sha256(stableJson(state)),
    grader_version: GRADER_VERSION,
  };
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
