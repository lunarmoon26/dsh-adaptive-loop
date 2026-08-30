import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { DalError } from "./errors.js";
import {
  calculateEvaluationMetrics,
  evaluationHardStopReasons,
  evaluationTargetDigestMatches,
  evaluationThresholdResults,
  evaluationWithinBudget,
  fixtureSetSha256,
  validateEvaluationScorecard,
  validateEvaluationSuite,
} from "./evaluation-contract.js";
import { runEvaluationCase } from "./evaluation-executor.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertNoSymlinkTraversal, repositoryPathUri } from "./repository.js";
import { loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { EvaluationScorecard } from "./types.js";

export {
  validateEvaluationScorecard,
  validateEvaluationSuite,
  validateEvaluationSuiteFile,
} from "./evaluation-contract.js";

export interface EvaluationRunResult {
  path: string;
  scorecard: EvaluationScorecard;
}

export async function runEvaluationSuite(
  suitePath: string,
  requestedStore?: string,
): Promise<EvaluationRunResult> {
  const policy = await loadPolicy();
  const resolvedSuitePath = resolve(process.cwd(), suitePath);
  await assertNoSymlinkTraversal(resolvedSuitePath, "EVALUATION_SUITE_INVALID", "Evaluation suite");
  const suiteDocument = await readJsonFile<unknown>(resolvedSuitePath);
  const suite = await validateEvaluationSuite(
    suiteDocument.value,
    suiteDocument.raw.toString("utf8"),
    resolvedSuitePath,
  );
  const startedAt = new Date();
  const started = performance.now();
  const targetMatches = await evaluationTargetDigestMatches(suite);

  const caseResults: EvaluationScorecard["case_results"] = [];
  for (const testCase of suite.cases) {
    const caseStart = performance.now();
    const observed = await runEvaluationCase(testCase, resolvedSuitePath, policy);
    const passed =
      observed.effect === testCase.expected_effect &&
      (testCase.expected_code === null || observed.code === testCase.expected_code);
    caseResults.push({
      case_id: testCase.id,
      category: testCase.category,
      expected_effect: testCase.expected_effect,
      observed_effect: observed.effect,
      code: observed.code,
      dangerous: testCase.dangerous,
      human_override: testCase.human_override,
      passed,
      duration_ms: performance.now() - caseStart,
    });
  }

  const metrics = calculateEvaluationMetrics(caseResults);
  const thresholdResults = evaluationThresholdResults(suite, metrics);

  const duration = performance.now() - started;
  const withinBudget = evaluationWithinBudget(suite, policy, duration);
  const reasons = evaluationHardStopReasons(suite, caseResults, thresholdResults, withinBudget, targetMatches);
  const hardStop = reasons.length > 0;
  const rollbackRequired = thresholdResults.some(
    (threshold) => threshold.metric === "post_change_regression_rate" && !threshold.passed,
  );
  const finishedAt = new Date();
  const scorecard: EvaluationScorecard = {
    $schema: SCHEMA_IDS.evaluationScorecard,
    storage_version: "1.0.0",
    scorecard_id: `score-${suite.suite_id.slice(6, 48)}-${randomUUID()}`,
    suite_id: suite.suite_id,
    suite_version: suite.suite_version,
    target: structuredClone(suite.target),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    provenance: {
      suite_uri: repositoryPathUri(resolvedSuitePath, "Evaluation suite"),
      suite_sha256: sha256(canonicalJson(suite)),
      suite_snapshot: structuredClone(suite),
      fixture_set_sha256: fixtureSetSha256(suite),
      policy_sha256: sha256(canonicalJson(policy)),
      policy_snapshot: structuredClone(policy),
    },
    evaluators: [
      {
        kind: "deterministic",
        id: "rdl-offline-evaluator",
        version: "1.0.0",
        external: false,
      },
    ],
    case_results: caseResults,
    metrics,
    threshold_results: thresholdResults,
    budget: {
      duration_ms: duration,
      tool_calls: suite.cases.length,
      external_requests: 0,
      external_cost_usd: 0,
      within_budget: withinBudget,
    },
    contamination: structuredClone(suite.contamination),
    model_judge_results: [],
    human_review: {
      status: "not_requested",
      reviewer: null,
      reviewed_at: null,
      notes: [],
    },
    result: hardStop ? "hard_stop" : "pass",
    hard_stop: {
      triggered: hardStop,
      reasons,
      disposition: hardStop ? (rollbackRequired ? "rollback" : "quarantine") : "continue",
    },
  };
  await validateEvaluationScorecard(scorecard, { verifyCurrentContext: true, replayCases: true });

  const store = resolve(process.cwd(), requestedStore ?? policy.default_evaluation_store);
  const destination = resolve(store, `${scorecard.scorecard_id}.json`);
  if (!(await publishJsonExclusive(destination, scorecard))) {
    throw new DalError("SCORECARD_ID_CONFLICT", `Scorecard path already exists: ${destination}`);
  }
  return { path: destination, scorecard };
}
