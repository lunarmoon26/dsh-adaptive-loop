import { DalError } from "../errors.js";
import { canonicalJson, sha256 } from "../json.js";
import type {
  ControllerMetricSource,
  ControllerPolicy,
  ControllerState,
  RunRecord,
} from "../types.js";

const WILSON_95_Z = 1.959963984540054;

export interface ControllerRunObservation {
  run: RunRecord;
  sha256: string;
}

type GenerationState = Omit<ControllerState["generation"], "sha256">;
type MeasurementContext = Omit<ControllerState["measurement_context"], "sha256">;

export function buildControllerState(
  policy: ControllerPolicy,
  policySha256: string,
  batchId: string,
  observations: readonly ControllerRunObservation[],
): ControllerState {
  const runtimePolicy = policy.runtime_generation;
  if (runtimePolicy === undefined) {
    throw new DalError(
      "CONTROL_RUNTIME_GENERATION_POLICY_REQUIRED",
      "Controller policy must select a runtime generation digest profile and minimum assurance",
    );
  }
  if (observations.length === 0) {
    throw new DalError("CONTROL_BATCH_EMPTY", `No run records match task set ${policy.task_set} and batch ${batchId}`);
  }
  if (observations.length > 10000) {
    throw new DalError("CONTROL_BATCH_TOO_LARGE", "Controller batches may contain at most 10000 runs");
  }
  for (const { run } of observations) {
    if (run.context.task_set !== policy.task_set) {
      throw new DalError("CONTROL_TASK_SET_MISMATCH", `Run ${run.run_id} does not match task set ${policy.task_set}`);
    }
    if ((run.batch_id ?? null) !== batchId) {
      throw new DalError("CONTROL_BATCH_MISMATCH", `Run ${run.run_id} does not match batch ${batchId}`);
    }
    assertUnique(
      (run.checks ?? []).map((check) => check.id),
      "CONTROL_CHECK_DUPLICATE",
      `Run ${run.run_id} contains duplicate deterministic check identities`,
    );
  }

  const sorted = [...observations].sort((left, right) => compareText(left.run.run_id, right.run.run_id));
  assertUniqueRunIds(sorted);
  assertUniqueRuntimeSessions(sorted);
  const generation = sharedGeneration(sorted, runtimePolicy);
  const measurementContext = sharedMeasurementContext(sorted);
  const runs = sorted.map(({ run, sha256: digest }) => ({ run_id: run.run_id, sha256: digest }));
  const inputSetSha256 = sha256(canonicalJson(runs));
  const firstStartedAt = selectTime(sorted.map(({ run }) => run.started_at), "first");
  const lastFinishedAt = selectTime(sorted.map(({ run }) => run.finished_at), "last");
  const seeds = [...new Set(sorted.flatMap(({ run }) => run.context.seeds))].sort((left, right) => left - right);
  const metrics = [...policy.metrics]
    .sort((left, right) => compareText(left.metric_id, right.metric_id))
    .map((metric) => estimateMetric(metric, sorted.map(({ run }) => run)));
  const status = metrics.every((metric) => metric.sufficient_evidence) ? "ready" : "insufficient_evidence";
  const generationSha256 = sha256(canonicalJson(generation));
  const contextSha256 = sha256(canonicalJson(measurementContext));
  const state: ControllerState = {
    $schema: "https://recursive-dev-loop.dev/schemas/controller-state.v1.schema.json",
    schema_version: "1.1.0",
    state_id: "",
    estimated_at: lastFinishedAt,
    task_class: policy.task_class,
    policy: { policy_id: policy.policy_id, sha256: policySha256 },
    generation: { sha256: generationSha256, ...generation },
    measurement_context: { sha256: contextSha256, ...measurementContext },
    observations: {
      batch_id: batchId,
      input_set_sha256: inputSetSha256,
      run_count: runs.length,
      first_started_at: firstStartedAt,
      last_finished_at: lastFinishedAt,
      seeds,
      runs,
    },
    estimator: policy.estimator,
    status,
    metrics,
  };
  state.state_id = controllerStateIdentity(state);
  return state;
}

export function wilsonScore95(successes: number, sampleCount: number): {
  mean: number | null;
  ci_low: number | null;
  ci_high: number | null;
} {
  if (!Number.isInteger(successes) || !Number.isInteger(sampleCount) || successes < 0 || sampleCount < successes) {
    throw new DalError("CONTROL_ESTIMATOR_INVALID", "Wilson score inputs must be non-negative integer counts");
  }
  if (sampleCount === 0) {
    return { mean: null, ci_low: null, ci_high: null };
  }
  const mean = successes / sampleCount;
  const zSquared = WILSON_95_Z * WILSON_95_Z;
  const denominator = 1 + zSquared / sampleCount;
  const center = (mean + zSquared / (2 * sampleCount)) / denominator;
  const margin =
    (WILSON_95_Z / denominator) *
    Math.sqrt((mean * (1 - mean) + zSquared / (4 * sampleCount)) / sampleCount);
  return {
    mean,
    ci_low: Math.max(0, center - margin),
    ci_high: Math.min(1, center + margin),
  };
}

export function controllerStateIdentity(state: ControllerState): string {
  const { state_id: _stateId, ...content } = state;
  return `ctlstate-${sha256(canonicalJson(content)).slice(0, 24)}`;
}

function estimateMetric(
  metric: ControllerPolicy["metrics"][number],
  runs: readonly RunRecord[],
): ControllerState["metrics"][number] {
  let successes = 0;
  let failures = 0;
  let excluded = 0;
  for (const run of runs) {
    const observation = metricObservation(metric.source, run);
    if (observation === "success") successes += 1;
    else if (observation === "failure") failures += 1;
    else excluded += 1;
  }
  const sampleCount = successes + failures;
  return {
    metric_id: metric.metric_id,
    source: metric.source,
    target: metric.target,
    deadband: metric.deadband,
    minimum_samples: metric.minimum_samples,
    successes,
    failures,
    excluded,
    sample_count: sampleCount,
    ...wilsonScore95(successes, sampleCount),
    sufficient_evidence: sampleCount >= metric.minimum_samples,
  };
}

function metricObservation(
  source: ControllerMetricSource,
  run: RunRecord,
): "success" | "failure" | "excluded" {
  if (source.kind === "harness_outcome") {
    return run.outcome === "succeeded" ? "success" : "failure";
  }
  if (source.kind === "business_outcome") {
    if (run.business_outcome?.status === "passed") return "success";
    if (run.business_outcome?.status === "failed") return "failure";
    return "excluded";
  }
  const matches = (run.checks ?? []).filter((check) => check.id === source.check_id);
  if (matches.length > 1) {
    throw new DalError(
      "CONTROL_CHECK_DUPLICATE",
      `Run ${run.run_id} contains duplicate deterministic check ${source.check_id}`,
    );
  }
  const check = matches[0];
  if (check === undefined) return "excluded";
  return check.pass ? "success" : "failure";
}

function sharedGeneration(
  observations: readonly ControllerRunObservation[],
  policy: NonNullable<ControllerPolicy["runtime_generation"]>,
): GenerationState {
  const states = observations.map(({ run }) => generationOf(run, policy));
  const expected = canonicalJson(states[0]);
  if (states.some((state) => canonicalJson(state) !== expected)) {
    throw new DalError("CONTROL_GENERATION_MISMATCH", "Selected runs do not share one harness generation");
  }
  return states[0]!;
}

function generationOf(run: RunRecord, policy: NonNullable<ControllerPolicy["runtime_generation"]>): GenerationState {
  if (run.context.harness_sha256 === null) {
    throw new DalError("CONTROL_GENERATION_UNPINNED", `Run ${run.run_id} has no harness digest`);
  }
  const modelPatchSha256 = run.context.model_patch_sha256 ?? null;
  if (modelPatchSha256 !== null && !/^[a-f0-9]{64}$/.test(modelPatchSha256)) {
    throw new DalError("CONTROL_GENERATION_UNPINNED", `Run ${run.run_id} has an invalid model-patch digest`);
  }
  const harnessPins = [...(run.context.harness_pins ?? [])].sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right)),
  );
  assertUnique(
    harnessPins.map((pin) => `${pin.surface}\u0000${pin.uri}`),
    "CONTROL_GENERATION_INVALID",
    `Run ${run.run_id} contains duplicate harness pin identities`,
  );
  const runtimeGeneration = run.runtime_generation;
  if (runtimeGeneration === undefined) {
    throw new DalError(
      "CONTROL_RUNTIME_GENERATION_UNATTESTED",
      `Run ${run.run_id} has no runtime generation attestation`,
    );
  }
  if (!runtimeGeneration.stable_for_session) {
    throw new DalError(
      "CONTROL_RUNTIME_GENERATION_UNSTABLE",
      `Run ${run.run_id} crossed a runtime generation transition`,
    );
  }
  if (runtimeGeneration.digest_profile !== policy.digest_profile) {
    throw new DalError(
      "CONTROL_RUNTIME_GENERATION_PROFILE_MISMATCH",
      `Run ${run.run_id} uses a runtime generation digest profile not accepted by the controller policy`,
    );
  }
  if (assuranceRank(runtimeGeneration.assurance) < assuranceRank(policy.minimum_assurance)) {
    throw new DalError(
      "CONTROL_RUNTIME_GENERATION_ASSURANCE_INSUFFICIENT",
      `Run ${run.run_id} does not meet the controller policy runtime generation assurance`,
    );
  }
  return {
    prompt_sha256: run.context.prompt_sha256,
    harness_sha256: run.context.harness_sha256,
    model_patch_sha256: modelPatchSha256,
    harness_pins: harnessPins,
    runtime_generation: {
      manifest_sha256: runtimeGeneration.manifest_sha256,
      digest_profile: runtimeGeneration.digest_profile,
    },
  };
}

function assuranceRank(assurance: "declared" | "observed" | "verified"): number {
  if (assurance === "verified") return 2;
  if (assurance === "observed") return 1;
  return 0;
}

function sharedMeasurementContext(observations: readonly ControllerRunObservation[]): MeasurementContext {
  const contexts = observations.map(({ run }) => measurementContextOf(run));
  const expected = canonicalJson(contexts[0]);
  if (contexts.some((context) => canonicalJson(context) !== expected)) {
    throw new DalError("CONTROL_CONTEXT_MISMATCH", "Selected runs do not share one measurement context");
  }
  return contexts[0]!;
}

function measurementContextOf(run: RunRecord): MeasurementContext {
  const toolVersions = [...run.context.tool_versions].sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right)),
  );
  const inferenceParameters = [...run.context.inference_parameters].sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right)),
  );
  assertUnique(
    toolVersions.map((tool) => tool.name),
    "CONTROL_CONTEXT_INVALID",
    `Run ${run.run_id} contains duplicate tool identities`,
  );
  assertUnique(
    inferenceParameters.map((parameter) => parameter.name),
    "CONTROL_CONTEXT_INVALID",
    `Run ${run.run_id} contains duplicate inference parameter names`,
  );
  return {
    task_set: run.context.task_set,
    environment_snapshot: run.context.environment_snapshot,
    tool_versions: toolVersions,
    model: run.context.model,
    grader_version: run.context.grader_version,
    context_policy_sha256: run.context.context_policy_sha256,
    inference_parameters: inferenceParameters,
  };
}

function assertUniqueRunIds(observations: readonly ControllerRunObservation[]): void {
  assertUnique(
    observations.map(({ run }) => run.run_id),
    "CONTROL_RUN_DUPLICATE",
    "Selected controller observations contain duplicate run identities",
  );
}

function assertUniqueRuntimeSessions(observations: readonly ControllerRunObservation[]): void {
  assertUnique(
    observations.flatMap(({ run }) => run.runtime_generation === undefined
      ? []
      : [run.runtime_generation.session_id_sha256]),
    "CONTROL_RUNTIME_GENERATION_SESSION_DUPLICATE",
    "Selected controller observations reuse one runtime generation session binding",
  );
}

function assertUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) {
    throw new DalError(code, message);
  }
}

function selectTime(values: readonly string[], direction: "first" | "last"): string {
  return [...values].sort((left, right) => {
    const difference = Date.parse(left) - Date.parse(right);
    return difference === 0 ? compareText(left, right) : difference;
  })[direction === "first" ? 0 : values.length - 1]!;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
