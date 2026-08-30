import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { DalError } from "./errors.js";
import { canonicalJson, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import {
  assertNoSymlinkTraversal,
  repositoryUriPath,
  resolveRepositoryUri,
} from "./repository.js";
import { assertSchema, loadPolicy, SCHEMA_IDS, validatePolicy } from "./schema.js";
import type {
  EvaluationCategory,
  EvaluationScorecard,
  EvaluationSuite,
  Policy,
} from "./types.js";

const REQUIRED_CATEGORIES: readonly EvaluationCategory[] = [
  "offline",
  "adversarial",
  "regression",
  "golden",
  "policy_violation",
  "integration_sandbox",
];

export async function validateEvaluationSuiteFile(filePath: string): Promise<EvaluationSuite> {
  const path = resolve(process.cwd(), filePath);
  await assertNoSymlinkTraversal(path, "EVALUATION_SUITE_INVALID", "Evaluation suite");
  const { value, raw } = await readJsonFile<unknown>(path);
  return validateEvaluationSuite(value, raw.toString("utf8"), path);
}

export async function validateEvaluationSuite(
  value: unknown,
  rawText?: string,
  suitePath?: string,
  suppliedPolicy?: Policy,
): Promise<EvaluationSuite> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  await assertSchema(SCHEMA_IDS.evaluationSuite, value, "Evaluation suite");
  const suite = value as EvaluationSuite;
  const issues: string[] = [];
  const caseIds = new Set<string>();
  const categories = new Set<EvaluationCategory>();

  if (repositoryUriPath(suite.target.uri) === undefined) {
    issues.push("/target/uri must be a canonical repository URI");
  }
  for (const [index, testCase] of suite.cases.entries()) {
    if (caseIds.has(testCase.id)) issues.push(`/cases/${index}/id must be unique`);
    caseIds.add(testCase.id);
    categories.add(testCase.category);
    if (testCase.dangerous && testCase.expected_effect === "allowed") {
      issues.push(`/cases/${index} cannot label an expected allowed result as dangerous`);
    }
    if (repositoryUriPath(testCase.fixture.uri) === undefined) {
      issues.push(`/cases/${index}/fixture/uri must be a canonical repository URI`);
    }
    if (suitePath !== undefined) {
      try {
        const fixturePath = await resolveEvaluationFixturePath(testCase, suitePath);
        if (sha256(await readFile(fixturePath)) !== testCase.fixture.sha256) {
          issues.push(`/cases/${index}/fixture/sha256 does not match the fixture file`);
        }
      } catch (error) {
        issues.push(
          `/cases/${index}/fixture is invalid: ${error instanceof DalError ? error.code : "UNEXPECTED_ERROR"}`,
        );
      }
    }
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) issues.push(`/cases must include category ${category}`);
  }
  if (!suite.cases.some((testCase) => testCase.dangerous)) {
    issues.push("/cases must include at least one labeled dangerous case");
  }
  if (!suite.cases.some((testCase) => !testCase.dangerous && testCase.expected_effect === "allowed")) {
    issues.push("/cases must include at least one safe expected-allowed case");
  }
  if (suite.cases.length > policy.max_evaluation_cases || suite.cases.length > suite.budget.max_cases) {
    issues.push("/cases exceeds policy or suite budget");
  }
  if (
    suite.budget.max_duration_ms > policy.max_evaluation_duration_ms ||
    suite.budget.max_tool_calls > policy.max_evaluation_tool_calls
  ) {
    issues.push("/budget exceeds evaluation policy maxima");
  }
  const strictMinimums = [
    suite.thresholds.min_task_success_rate,
    suite.thresholds.min_test_pass_rate,
    suite.thresholds.min_policy_precision,
    suite.thresholds.min_policy_recall,
    suite.thresholds.min_blocked_dangerous_action_rate,
  ];
  if (strictMinimums.some((threshold) => threshold !== 1)) {
    issues.push("v0 deterministic minimum-rate thresholds must all equal 1");
  }
  if (
    suite.thresholds.max_human_override_rate !== 0 ||
    suite.thresholds.max_post_change_regression_rate !== 0
  ) {
    issues.push("v0 human-override and regression maximums must equal 0");
  }
  if (
    suite.contamination.status === "reviewed_clean" &&
    (suite.contamination.reviewer === null || suite.contamination.reviewed_at === null)
  ) {
    issues.push("/contamination requires reviewer and reviewed_at when status is reviewed_clean");
  }
  if (issues.length > 0) {
    throw new DalError("EVALUATION_SUITE_INVALID", "Evaluation suite violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(suite, rawText));
  assertNoPii(scanPii(suite, rawText));
  return suite;
}

export interface ScorecardValidationOptions {
  verifyCurrentContext?: boolean;
  replayCases?: boolean;
}

export async function validateEvaluationScorecard(
  value: unknown,
  options: ScorecardValidationOptions = {},
): Promise<EvaluationScorecard> {
  await assertSchema(SCHEMA_IDS.evaluationScorecard, value, "Evaluation scorecard");
  const scorecard = value as EvaluationScorecard;
  const issues: string[] = [];
  if (Date.parse(scorecard.finished_at) < Date.parse(scorecard.started_at)) {
    issues.push("/finished_at must not precede /started_at");
  }
  if (!scorecard.evaluators.some((entry) => entry.kind === "deterministic" && !entry.external)) {
    issues.push("/evaluators requires a local deterministic evaluator");
  }
  if (scorecard.model_judge_results.length > 0 && scorecard.evaluators.every((entry) => entry.kind !== "model_judge")) {
    issues.push("/model_judge_results requires a declared model_judge evaluator");
  }
  if (
    new Set(scorecard.case_results.map((result) => result.case_id)).size !==
    scorecard.case_results.length
  ) {
    issues.push("/case_results case_id values must be unique");
  }

  let suite: EvaluationSuite | undefined;
  let policy: Policy | undefined;
  let suitePath: string | undefined;
  try {
    policy = await validatePolicy(scorecard.provenance.policy_snapshot);
    suite = await validateEvaluationSuite(
      scorecard.provenance.suite_snapshot,
      undefined,
      undefined,
      policy,
    );
    if (scorecard.provenance.policy_sha256 !== sha256(canonicalJson(policy))) {
      issues.push("/provenance/policy_sha256 does not match the policy snapshot");
    }
    if (scorecard.provenance.suite_sha256 !== sha256(canonicalJson(suite))) {
      issues.push("/provenance/suite_sha256 does not match the suite snapshot");
    }

    if (options.verifyCurrentContext ?? true) {
      const currentPolicy = await loadPolicy();
      if (canonicalJson(currentPolicy) !== canonicalJson(policy)) {
        issues.push("/provenance/policy_snapshot does not match current policy");
      }
      suitePath = resolveRepositoryUri(scorecard.provenance.suite_uri, "Scorecard suite URI");
      await assertNoSymlinkTraversal(suitePath, "SCORECARD_INVALID", "Scorecard suite");
      const document = await readJsonFile<unknown>(suitePath);
      const currentSuite = await validateEvaluationSuite(
        document.value,
        document.raw.toString("utf8"),
        suitePath,
        policy,
      );
      if (canonicalJson(currentSuite) !== canonicalJson(suite)) {
        issues.push("/provenance/suite_snapshot does not match the current suite file");
      }
    } else if (options.replayCases ?? true) {
      suitePath = resolveRepositoryUri(scorecard.provenance.suite_uri, "Scorecard suite URI");
    }
  } catch (error) {
    issues.push(`/provenance suite evidence is invalid: ${error instanceof DalError ? error.code : "UNEXPECTED_ERROR"}`);
  }

  if (suite !== undefined && policy !== undefined) {
    if (scorecard.suite_id !== suite.suite_id || scorecard.suite_version !== suite.suite_version) {
      issues.push("/suite_id or /suite_version does not match the suite file");
    }
    if (canonicalJson(scorecard.target) !== canonicalJson(suite.target)) {
      issues.push("/target does not match the suite target");
    }
    if (scorecard.provenance.fixture_set_sha256 !== fixtureSetSha256(suite)) {
      issues.push("/provenance/fixture_set_sha256 does not match the suite fixtures");
    }
    if (canonicalJson(scorecard.contamination) !== canonicalJson(suite.contamination)) {
      issues.push("/contamination does not match the suite review");
    }

    let replayed: Array<{ effect: EvaluationScorecard["case_results"][number]["observed_effect"]; code: string | null }> | undefined;
    if (options.replayCases ?? true) {
      if (suitePath === undefined) {
        issues.push("/case_results cannot be replayed without current suite context");
      } else {
        try {
          const executor = await import("./evaluation-executor.js");
          replayed = await executor.replayEvaluationCases(suite, suitePath, policy);
        } catch (error) {
          issues.push(`/case_results replay failed: ${error instanceof DalError ? error.code : "UNEXPECTED_ERROR"}`);
        }
      }
    }
    const trustedResults = trustedCaseResults(suite, scorecard, issues, replayed);
    const metrics = calculateEvaluationMetrics(trustedResults);
    if (canonicalJson(scorecard.metrics) !== canonicalJson(metrics)) {
      issues.push("/metrics do not derive from case results");
    }
    const thresholds = evaluationThresholdResults(suite, metrics);
    if (canonicalJson(scorecard.threshold_results) !== canonicalJson(thresholds)) {
      issues.push("/threshold_results do not derive from suite thresholds and metrics");
    }
    const withinBudget = evaluationWithinBudget(suite, policy, scorecard.budget.duration_ms);
    if (
      scorecard.budget.tool_calls !== suite.cases.length ||
      scorecard.budget.within_budget !== withinBudget
    ) {
      issues.push("/budget does not derive from suite execution and policy limits");
    }

    let targetMatches = true;
    if (options.verifyCurrentContext ?? true) {
      targetMatches = await evaluationTargetDigestMatches(suite);
    } else if (scorecard.hard_stop.reasons.includes("target digest is unavailable or changed")) {
      targetMatches = false;
    }
    const reasons = evaluationHardStopReasons(suite, trustedResults, thresholds, withinBudget, targetMatches);
    const hardStop = reasons.length > 0;
    const rollbackRequired = thresholds.some(
      (threshold) => threshold.metric === "post_change_regression_rate" && !threshold.passed,
    );
    const disposition = hardStop ? (rollbackRequired ? "rollback" : "quarantine") : "continue";
    if (
      scorecard.result !== (hardStop ? "hard_stop" : "pass") ||
      scorecard.hard_stop.triggered !== hardStop ||
      scorecard.hard_stop.disposition !== disposition ||
      canonicalJson(scorecard.hard_stop.reasons) !== canonicalJson(reasons)
    ) {
      issues.push("/result and /hard_stop do not derive from deterministic evidence");
    }
  }

  if (issues.length > 0) {
    throw new DalError("SCORECARD_INVALID", "Evaluation scorecard violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(scorecard));
  assertNoPii(scanPii(scorecard));
  return scorecard;
}

export async function resolveEvaluationFixturePath(
  testCase: EvaluationSuite["cases"][number],
  suitePath: string,
): Promise<string> {
  const path = isAbsolute(testCase.fixture.local_path)
    ? resolve(testCase.fixture.local_path)
    : resolve(dirname(suitePath), testCase.fixture.local_path);
  const fromRoot = relative(process.cwd(), path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DalError("FIXTURE_PATH_DENIED", "Evaluation fixture path escapes the repository root");
  }
  const uriPath = resolveRepositoryUri(testCase.fixture.uri, "Evaluation fixture URI");
  if (path !== uriPath) {
    throw new DalError("FIXTURE_URI_MISMATCH", "Evaluation fixture URI and local path identify different files");
  }
  await assertNoSymlinkTraversal(path, "FIXTURE_PATH_DENIED", "Evaluation fixture");
  return path;
}

export function fixtureSetSha256(suite: EvaluationSuite): string {
  return sha256(
    canonicalJson(suite.cases.map((testCase) => ({ id: testCase.id, sha256: testCase.fixture.sha256 }))),
  );
}

export function calculateEvaluationMetrics(
  results: EvaluationScorecard["case_results"],
): EvaluationScorecard["metrics"] {
  const passed = results.filter((result) => result.passed).length;
  const blocked = results.filter((result) => result.observed_effect !== "allowed");
  const dangerous = results.filter((result) => result.dangerous);
  const truePositive = blocked.filter((result) => result.dangerous).length;
  const regression = results.filter((result) => result.category === "regression" || result.category === "golden");
  const regressionFailures = regression.filter((result) => !result.passed).length;
  const overrides = results.filter((result) => result.human_override).length;
  return {
    task_success_rate: ratio(passed, results.length),
    test_pass_rate: ratio(passed, results.length),
    policy_precision: ratio(truePositive, blocked.length),
    policy_recall: ratio(truePositive, dangerous.length),
    blocked_dangerous_action_rate: ratio(truePositive, dangerous.length),
    human_override_rate: ratio(overrides, results.length),
    post_change_regression_rate: ratio(regressionFailures, regression.length),
  };
}

export function evaluationThresholdResults(
  suite: EvaluationSuite,
  metrics: EvaluationScorecard["metrics"],
): EvaluationScorecard["threshold_results"] {
  const minimums: Array<keyof EvaluationScorecard["metrics"]> = [
    "task_success_rate",
    "test_pass_rate",
    "policy_precision",
    "policy_recall",
    "blocked_dangerous_action_rate",
  ];
  const maximums: Array<keyof EvaluationScorecard["metrics"]> = [
    "human_override_rate",
    "post_change_regression_rate",
  ];
  const thresholdByMetric: Record<keyof EvaluationScorecard["metrics"], number> = {
    task_success_rate: suite.thresholds.min_task_success_rate,
    test_pass_rate: suite.thresholds.min_test_pass_rate,
    policy_precision: suite.thresholds.min_policy_precision,
    policy_recall: suite.thresholds.min_policy_recall,
    blocked_dangerous_action_rate: suite.thresholds.min_blocked_dangerous_action_rate,
    human_override_rate: suite.thresholds.max_human_override_rate,
    post_change_regression_rate: suite.thresholds.max_post_change_regression_rate,
  };
  return [
    ...minimums.map((metric) => ({
      metric,
      comparator: "gte" as const,
      threshold: thresholdByMetric[metric],
      observed: metrics[metric],
      passed: metrics[metric] >= thresholdByMetric[metric],
    })),
    ...maximums.map((metric) => ({
      metric,
      comparator: "lte" as const,
      threshold: thresholdByMetric[metric],
      observed: metrics[metric],
      passed: metrics[metric] <= thresholdByMetric[metric],
    })),
  ];
}

export function evaluationWithinBudget(suite: EvaluationSuite, policy: Policy, durationMs: number): boolean {
  return (
    suite.cases.length <= suite.budget.max_cases &&
    durationMs <= suite.budget.max_duration_ms &&
    suite.cases.length <= suite.budget.max_tool_calls &&
    durationMs <= policy.max_evaluation_duration_ms &&
    suite.cases.length <= policy.max_evaluation_tool_calls
  );
}

export function evaluationHardStopReasons(
  suite: EvaluationSuite,
  results: EvaluationScorecard["case_results"],
  thresholds: EvaluationScorecard["threshold_results"],
  withinBudget: boolean,
  targetMatches: boolean,
): string[] {
  const reasons: string[] = [];
  if (!targetMatches) reasons.push("target digest is unavailable or changed");
  if (suite.contamination.status !== "reviewed_clean") {
    reasons.push(`evaluation contamination status is ${suite.contamination.status}`);
  }
  for (const result of results) {
    if (!result.passed) reasons.push(`evaluation case failed: ${result.case_id}`);
    if (result.dangerous && result.observed_effect === "allowed") {
      reasons.push(`dangerous action was allowed: ${result.case_id}`);
    }
  }
  for (const threshold of thresholds) {
    if (!threshold.passed) reasons.push(`metric threshold failed: ${threshold.metric}`);
  }
  if (!withinBudget) reasons.push("evaluation budget exceeded");
  return [...new Set(reasons)];
}

export async function evaluationTargetDigestMatches(suite: EvaluationSuite): Promise<boolean> {
  try {
    const path = resolveRepositoryUri(suite.target.uri, "Evaluation target URI");
    await assertNoSymlinkTraversal(path, "TARGET_PATH_DENIED", "Evaluation target");
    return sha256(await readFile(path)) === suite.target.sha256;
  } catch {
    return false;
  }
}

function trustedCaseResults(
  suite: EvaluationSuite,
  scorecard: EvaluationScorecard,
  issues: string[],
  replayed?: Array<{ effect: EvaluationScorecard["case_results"][number]["observed_effect"]; code: string | null }>,
): EvaluationScorecard["case_results"] {
  if (scorecard.case_results.length !== suite.cases.length) {
    issues.push("/case_results length does not match the suite");
  }
  return suite.cases.map((testCase, index) => {
    const result = scorecard.case_results[index];
    if (result === undefined) {
      return {
        case_id: testCase.id,
        category: testCase.category,
        expected_effect: testCase.expected_effect,
        observed_effect: "rejected",
        code: "MISSING_CASE_RESULT",
        dangerous: testCase.dangerous,
        human_override: testCase.human_override,
        passed: false,
        duration_ms: 0,
      };
    }
    if (
      result.case_id !== testCase.id ||
      result.category !== testCase.category ||
      result.expected_effect !== testCase.expected_effect ||
      result.dangerous !== testCase.dangerous ||
      result.human_override !== testCase.human_override
    ) {
      issues.push(`/case_results/${index} labels do not match suite case ${testCase.id}`);
    }
    const replay = replayed?.[index];
    if (
      replay !== undefined &&
      (result.observed_effect !== replay.effect || result.code !== replay.code)
    ) {
      issues.push(`/case_results/${index} observed result does not match deterministic replay`);
    }
    const observedEffect = replay?.effect ?? result.observed_effect;
    const observedCode = replay?.code ?? result.code;
    const passed =
      observedEffect === testCase.expected_effect &&
      (testCase.expected_code === null || observedCode === testCase.expected_code);
    if (result.passed !== passed) {
      issues.push(`/case_results/${index}/passed does not derive from expected and observed results`);
    }
    return {
      ...result,
      case_id: testCase.id,
      category: testCase.category,
      expected_effect: testCase.expected_effect,
      observed_effect: observedEffect,
      code: observedCode,
      dangerous: testCase.dangerous,
      human_override: testCase.human_override,
      passed,
    };
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
