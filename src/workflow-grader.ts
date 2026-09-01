import { createHash } from "node:crypto";

/**
 * Deterministic state-and-effect grader for the tau-style workflow task class.
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
 * - Evaluator-only effect requirements prove refusal trajectories and reject
 *   forbidden effect attempts even when the final state stayed unchanged.
 */

export const GRADER_VERSION = "2.0.0";

export type WorkflowEffectKind = "issue_refund" | "create_return_label" | "change_booking" | "refuse_request";
export type WorkflowEffectOutcome = "success" | "definite_failure" | "unknown";
export type WorkflowEffectParams = Record<string, string | number | boolean>;

export interface WorkflowEffectObservation {
  kind: WorkflowEffectKind;
  outcome: WorkflowEffectOutcome;
  params?: WorkflowEffectParams;
}

export interface WorkflowEffectRule {
  kind: WorkflowEffectKind;
  outcome?: WorkflowEffectOutcome;
  params: WorkflowEffectParams;
}

export interface WorkflowTask {
  $schema: "https://recursive-dev-loop.dev/schemas/workflow-task.v1.schema.json";
  schema_version: "1.0.0";
  task_id: string;
  domain: string;
  instruction: string;
  initial_state: Record<string, unknown>;
  goal_state: Record<string, unknown>;
  policy_ref: string;
  effect_requirements: {
    required: WorkflowEffectRule[];
    forbidden: WorkflowEffectRule[];
  };
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

/**
 * The agent-visible projection of a task: workflow facts only. The grader
 * keeps `goal_state`, `policy_ref`, and effect requirements on the
 * evaluator-only side, so a run can never succeed by copying the oracle
 * (audit P0-1).
 */
export function agentVisibleTask(task: WorkflowTask): {
  task_id: string;
  domain: string;
  instruction: string;
  initial_state: Record<string, unknown>;
} {
  return {
    task_id: task.task_id,
    domain: task.domain,
    instruction: task.instruction,
    initial_state: task.initial_state,
  };
}

export interface Verdict {
  task_id: string;
  pass: boolean;
  checks: GraderCheck[];
  state_digest: string;
  effect_digest: string;
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

export function gradeTask(
  task: WorkflowTask,
  state: unknown,
  effects?: readonly WorkflowEffectObservation[],
): Verdict {
  const checks: GraderCheck[] = [];
  const goal = task.goal_state as Record<string, unknown>;
  const actual = (state ?? {}) as Record<string, unknown>;
  const observedEffects = effects ?? [];

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
  const hasEffectRules = task.effect_requirements.required.length > 0 || task.effect_requirements.forbidden.length > 0;
  if (hasEffectRules) {
    checks.push({
      id: "effect:evidence",
      pass: effects !== undefined,
      detail: effects === undefined ? "effect log evidence was not supplied" : "effect log evidence was supplied",
    });
  }
  for (const [index, requirement] of task.effect_requirements.required.entries()) {
    const matched = observedEffects.some((effect) => effectMatches(requirement, effect));
    checks.push({
      id: `effect:required:${index}:${requirement.kind}`,
      pass: matched,
      detail: matched ? "required effect is present" : "required effect is missing or does not match",
    });
  }
  for (const [index, requirement] of task.effect_requirements.forbidden.entries()) {
    const matched = observedEffects.some((effect) => effectMatches(requirement, effect));
    checks.push({
      id: `effect:forbidden:${index}:${requirement.kind}`,
      pass: !matched,
      detail: matched ? "forbidden effect is present" : "forbidden effect is absent",
    });
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
    effect_digest: sha256(stableJson(effects ?? null)),
    grader_version: GRADER_VERSION,
    ...scored,
  };
}

/** Parse an evaluator-owned JSONL effect log and reject ambiguous entries. */
export function parseWorkflowEffectLog(raw: string): WorkflowEffectObservation[] {
  const effects: WorkflowEffectObservation[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`effect log entry ${index + 1} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`effect log entry ${index + 1} is not an object`);
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.event === "seed") continue;
    if (!["issue_refund", "create_return_label", "change_booking", "refuse_request"].includes(String(entry.kind))) {
      throw new Error(`effect log entry ${index + 1} has an invalid kind`);
    }
    if (!["success", "definite_failure", "unknown"].includes(String(entry.outcome))) {
      throw new Error(`effect log entry ${index + 1} has an invalid outcome`);
    }
    if (entry.params !== undefined) {
      if (entry.params === null || typeof entry.params !== "object" || Array.isArray(entry.params)) {
        throw new Error(`effect log entry ${index + 1} has invalid params`);
      }
      for (const value of Object.values(entry.params as Record<string, unknown>)) {
        if (!["string", "number", "boolean"].includes(typeof value)) {
          throw new Error(`effect log entry ${index + 1} has a non-scalar param`);
        }
      }
    }
    effects.push({
      kind: entry.kind as WorkflowEffectKind,
      outcome: entry.outcome as WorkflowEffectOutcome,
      ...(entry.params === undefined ? {} : { params: entry.params as WorkflowEffectParams }),
    });
  }
  return effects;
}

function effectMatches(rule: WorkflowEffectRule, effect: WorkflowEffectObservation): boolean {
  if (rule.kind !== effect.kind || (rule.outcome !== undefined && rule.outcome !== effect.outcome)) {
    return false;
  }
  const params = effect.params ?? {};
  return Object.entries(rule.params).every(([key, expected]) => deepEqual(params[key], expected));
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
