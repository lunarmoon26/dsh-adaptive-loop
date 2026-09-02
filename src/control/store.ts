import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "../errors.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "../json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "../privacy.js";
import { validateRunRecord } from "../runs.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "../schema.js";
import type { ControllerMetricSource, ControllerPolicy, ControllerState, Policy, RunRecord } from "../types.js";
import { buildControllerState, controllerStateIdentity, wilsonScore95 } from "./estimator.js";

export interface EstimateControllerStateOptions {
  policyPath: string;
  batchId: string;
  runs?: string;
  store?: string;
  policy?: Policy;
}

export interface EstimateControllerStateResult {
  status: "stored" | "idempotent";
  path: string;
  state_sha256: string;
  state: ControllerState;
}

export async function estimateControllerState(
  options: EstimateControllerStateOptions,
): Promise<EstimateControllerStateResult> {
  const globalPolicy = options.policy ?? (await loadPolicy());
  const controllerPolicyDocument = await readJsonFile<unknown>(options.policyPath);
  const controllerPolicy = await validateControllerPolicy(
    controllerPolicyDocument.value,
    controllerPolicyDocument.raw.toString("utf8"),
  );
  const controllerPolicySha256 = sha256(canonicalJson(controllerPolicy));
  const batchId = options.batchId;
  if (batchId.trim() === "") {
    throw new DalError("USAGE_ERROR", "Missing required option --batch");
  }
  if (batchId !== batchId.trim()) {
    throw new DalError("CONTROL_BATCH_INVALID", "Batch IDs must match exactly and cannot contain surrounding whitespace");
  }
  const runStore = resolve(process.cwd(), options.runs ?? globalPolicy.default_run_store);
  const observations = await readBatch(runStore, controllerPolicy.task_set, batchId);
  const state = buildControllerState(controllerPolicy, controllerPolicySha256, batchId, observations);
  await validateControllerState(state);
  assertNoSecrets(scanSecrets(state));
  assertNoPii(scanPii(state));

  const store = resolve(process.cwd(), options.store ?? ".dal/control-states");
  const destination = resolve(store, `${state.state_id}.json`);
  const stateSha256 = sha256(canonicalJson(state));
  const published = await publishJsonExclusive(destination, state);
  if (published) {
    return { status: "stored", path: destination, state_sha256: stateSha256, state };
  }
  const existing = await readJsonFile<unknown>(destination);
  const existingState = await validateControllerState(existing.value);
  if (canonicalJson(existingState) === canonicalJson(state)) {
    return { status: "idempotent", path: destination, state_sha256: stateSha256, state: existingState };
  }
  throw new DalError("CONTROL_STATE_CONFLICT", `Controller state ${state.state_id} already exists with different content`);
}

export async function validateControllerPolicy(value: unknown, rawText?: string): Promise<ControllerPolicy> {
  await assertSchema(SCHEMA_IDS.controllerPolicy, value, "Controller policy");
  const policy = value as ControllerPolicy;
  const issues: string[] = [];
  duplicateIssues(issues, "/metrics", policy.metrics.map((metric) => metric.metric_id), "metric_id");
  duplicateIssues(issues, "/metrics", policy.metrics.map((metric) => metricSourceKey(metric.source)), "source");
  policy.metrics.forEach((metric, index) => {
    if (metric.deadband > metric.target) {
      issues.push(`/metrics/${index}/deadband must not exceed target`);
    }
  });
  if (issues.length > 0) {
    throw new DalError("CONTROL_POLICY_INVALID", "Controller policy violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(policy, rawText));
  assertNoPii(scanPii(policy, rawText));
  return policy;
}

export async function validateControllerState(value: unknown): Promise<ControllerState> {
  await assertSchema(SCHEMA_IDS.controllerState, value, "Controller state");
  const state = value as ControllerState;
  const issues: string[] = [];
  if (state.state_id !== controllerStateIdentity(state)) {
    issues.push("/state_id does not match the canonical controller state content");
  }
  const generation = {
    prompt_sha256: state.generation.prompt_sha256,
    harness_sha256: state.generation.harness_sha256,
    model_patch_sha256: state.generation.model_patch_sha256,
    harness_pins: state.generation.harness_pins,
  };
  if (state.generation.sha256 !== sha256(canonicalJson(generation))) {
    issues.push("/generation/sha256 does not match generation fields");
  }
  const measurementContext = {
    task_set: state.measurement_context.task_set,
    environment_snapshot: state.measurement_context.environment_snapshot,
    tool_versions: state.measurement_context.tool_versions,
    model: state.measurement_context.model,
    grader_version: state.measurement_context.grader_version,
    context_policy_sha256: state.measurement_context.context_policy_sha256,
    inference_parameters: state.measurement_context.inference_parameters,
  };
  if (state.measurement_context.sha256 !== sha256(canonicalJson(measurementContext))) {
    issues.push("/measurement_context/sha256 does not match context fields");
  }
  if (state.observations.input_set_sha256 !== sha256(canonicalJson(state.observations.runs))) {
    issues.push("/observations/input_set_sha256 does not match run identities");
  }
  if (state.observations.run_count !== state.observations.runs.length) {
    issues.push("/observations/run_count does not match runs length");
  }
  if (Date.parse(state.observations.first_started_at) > Date.parse(state.observations.last_finished_at)) {
    issues.push("/observations/first_started_at must not follow last_finished_at");
  }
  if (state.estimated_at !== state.observations.last_finished_at) {
    issues.push("/estimated_at must equal /observations/last_finished_at");
  }
  duplicateIssues(issues, "/observations/runs", state.observations.runs.map((run) => run.run_id), "run_id");
  duplicateIssues(issues, "/metrics", state.metrics.map((metric) => metric.metric_id), "metric_id");
  duplicateIssues(issues, "/metrics", state.metrics.map((metric) => metricSourceKey(metric.source)), "source");
  duplicateIssues(
    issues,
    "/generation/harness_pins",
    state.generation.harness_pins.map((pin) => `${pin.surface}\u0000${pin.uri}`),
    "identity",
  );
  duplicateIssues(
    issues,
    "/measurement_context/tool_versions",
    state.measurement_context.tool_versions.map((tool) => tool.name),
    "name",
  );
  duplicateIssues(
    issues,
    "/measurement_context/inference_parameters",
    state.measurement_context.inference_parameters.map((parameter) => parameter.name),
    "name",
  );
  if (!isSorted(state.observations.runs.map((run) => run.run_id))) {
    issues.push("/observations/runs must be sorted by run_id");
  }
  if (!isSorted(state.observations.seeds, (left, right) => left - right)) {
    issues.push("/observations/seeds must be sorted");
  }
  if (!isSorted(state.metrics.map((metric) => metric.metric_id))) {
    issues.push("/metrics must be sorted by metric_id");
  }
  if (!isSorted(state.generation.harness_pins.map((pin) => canonicalJson(pin)))) {
    issues.push("/generation/harness_pins must be canonically sorted");
  }
  if (!isSorted(state.measurement_context.tool_versions.map((tool) => canonicalJson(tool)))) {
    issues.push("/measurement_context/tool_versions must be canonically sorted");
  }
  if (!isSorted(state.measurement_context.inference_parameters.map((parameter) => canonicalJson(parameter)))) {
    issues.push("/measurement_context/inference_parameters must be canonically sorted");
  }
  state.metrics.forEach((metric, index) => validateMetricEstimate(issues, metric, state.observations.run_count, index));
  const expectedStatus = state.metrics.every((metric) => metric.sufficient_evidence)
    ? "ready"
    : "insufficient_evidence";
  if (state.status !== expectedStatus) {
    issues.push(`/status must be ${expectedStatus} for the metric sufficiency results`);
  }
  if (issues.length > 0) {
    throw new DalError("CONTROL_STATE_INVALID", "Controller state violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(state));
  assertNoPii(scanPii(state));
  return state;
}

async function readBatch(
  store: string,
  taskSet: string,
  batchId: string,
): Promise<Array<{ run: RunRecord; sha256: string }>> {
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new DalError("CONTROL_RUN_STORE_MISSING", `Run store is not readable: ${store}`);
  }
  const observations: Array<{ run: RunRecord; sha256: string }> = [];
  for (const name of names) {
    const document = await readJsonFile<unknown>(resolve(store, name));
    const run = await validateRunRecord(document.value, document.raw.toString("utf8"));
    if (run.context.task_set !== taskSet || (run.batch_id ?? null) !== batchId) continue;
    observations.push({ run, sha256: sha256(canonicalJson(run)) });
  }
  return observations;
}

function validateMetricEstimate(
  issues: string[],
  metric: ControllerState["metrics"][number],
  runCount: number,
  index: number,
): void {
  const path = `/metrics/${index}`;
  if (metric.successes + metric.failures !== metric.sample_count) {
    issues.push(`${path}/sample_count must equal successes plus failures`);
  }
  if (metric.sample_count + metric.excluded !== runCount) {
    issues.push(`${path} counts must account for every selected run`);
  }
  if (metric.deadband > metric.target) {
    issues.push(`${path}/deadband must not exceed target`);
  }
  const expected = metric.sample_count === 0 ? null : metric.successes / metric.sample_count;
  if (!sameNumber(metric.mean, expected)) {
    issues.push(`${path}/mean does not match successes/sample_count`);
  }
  if (metric.successes <= metric.sample_count) {
    const expectedInterval = wilsonScore95(metric.successes, metric.sample_count);
    if (!sameNumber(metric.ci_low, expectedInterval.ci_low) || !sameNumber(metric.ci_high, expectedInterval.ci_high)) {
      issues.push(`${path} confidence bounds do not match dal-wilson-score-v1`);
    }
  }
  const intervals = [metric.ci_low, metric.ci_high];
  if (metric.sample_count === 0 && intervals.some((value) => value !== null)) {
    issues.push(`${path} confidence bounds must be null when sample_count is zero`);
  }
  if (metric.sample_count > 0) {
    if (metric.ci_low === null || metric.ci_high === null || metric.mean === null) {
      issues.push(`${path} mean and confidence bounds are required when observations exist`);
    } else if (metric.ci_low > metric.mean || metric.mean > metric.ci_high) {
      issues.push(`${path} confidence bounds must contain the mean`);
    }
  }
  if (metric.sufficient_evidence !== (metric.sample_count >= metric.minimum_samples)) {
    issues.push(`${path}/sufficient_evidence does not match minimum_samples`);
  }
}

function sameNumber(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Number.EPSILON;
}

function metricSourceKey(source: ControllerMetricSource): string {
  return source.kind === "check" ? `check:${source.check_id}` : source.kind;
}

function duplicateIssues(issues: string[], path: string, values: readonly string[], label: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push(`${path}/${index}/${label} duplicates ${value}`);
    seen.add(value);
  });
}

function isSorted<T>(values: readonly T[], compare: (left: T, right: T) => number = defaultCompare): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}

function defaultCompare<T>(left: T, right: T): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
