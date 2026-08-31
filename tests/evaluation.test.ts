import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runEvaluationSuite,
  validateEvaluationScorecard,
  validateEvaluationSuite,
  validateEvaluationSuiteFile,
} from "../src/evaluation.js";
import type { EvaluationScorecard, EvaluationSuite } from "../src/types.js";

const suitePath = resolve(import.meta.dirname, "fixtures", "evaluation", "v0-suite.json");

describe("offline evaluation harness", () => {
  it("covers every required suite category", async () => {
    const suite = await validateEvaluationSuiteFile(suitePath);
    expect(new Set(suite.cases.map((testCase) => testCase.category))).toEqual(
      new Set(["offline", "adversarial", "regression", "golden", "policy_violation", "integration_sandbox"]),
    );
  });

  it("rejects a suite with no labeled dangerous coverage", async () => {
    const suite = JSON.parse(await readFile(suitePath, "utf8")) as EvaluationSuite;
    for (const testCase of suite.cases) testCase.dangerous = false;

    await expect(validateEvaluationSuite(suite)).rejects.toMatchObject({ code: "EVALUATION_SUITE_INVALID" });
  });

  it("rejects a suite whose fixture URI and local path identify different files", async () => {
    const suite = JSON.parse(await readFile(suitePath, "utf8")) as EvaluationSuite;
    suite.cases[0]!.fixture.uri = "repo://tests/fixtures/feedback/blocked.json";

    await expect(validateEvaluationSuite(suite, undefined, suitePath)).rejects.toMatchObject({
      code: "EVALUATION_SUITE_INVALID",
    });
  });

  it("produces an immutable passing scorecard with zero external use", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-evaluation-pass-"));
    const result = await runEvaluationSuite(suitePath, store);
    const persisted = JSON.parse(await readFile(result.path, "utf8")) as EvaluationScorecard;

    expect(result.scorecard.result).toBe("pass");
    expect(result.scorecard.metrics).toEqual({
      task_success_rate: 1,
      test_pass_rate: 1,
      policy_precision: 1,
      policy_recall: 1,
      blocked_dangerous_action_rate: 1,
      human_override_rate: 0,
      post_change_regression_rate: 0,
    });
    expect(result.scorecard.budget).toMatchObject({
      external_requests: 0,
      external_cost_usd: 0,
      within_budget: true,
    });
    expect(result.scorecard.model_judge_results).toEqual([]);
    await expect(validateEvaluationScorecard(persisted)).resolves.toEqual(persisted);

    const forged = structuredClone(persisted);
    const dangerous = forged.case_results.find((testCase) => testCase.dangerous)!;
    dangerous.observed_effect = "allowed";
    dangerous.code = null;
    dangerous.passed = true;
    await expect(validateEvaluationScorecard(forged)).rejects.toMatchObject({ code: "SCORECARD_INVALID" });
  });

  it("hard-stops and selects rollback when a regression case fails", async () => {
    const suite = JSON.parse(await readFile(suitePath, "utf8")) as EvaluationSuite;
    for (const testCase of suite.cases) {
      testCase.fixture.local_path = resolve(dirname(suitePath), testCase.fixture.local_path);
    }
    const regression = suite.cases.find((testCase) => testCase.id === "case-regression-read")!;
    regression.expected_effect = "rejected";
    const root = await mkdtemp(join(tmpdir(), "dal-evaluation-hard-stop-"));
    const suiteRoot = resolve(import.meta.dirname, "..", ".dal", "test-suites");
    await mkdir(suiteRoot, { recursive: true });
    const changedSuitePath = join(suiteRoot, `hard-stop-${randomUUID()}.json`);
    await writeFile(changedSuitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");

    const result = await runEvaluationSuite(changedSuitePath, join(root, "scorecards"));
    expect(result.scorecard.result).toBe("hard_stop");
    expect(result.scorecard.hard_stop.disposition).toBe("rollback");
    expect(result.scorecard.metrics.post_change_regression_rate).toBeGreaterThan(0);
    expect(result.scorecard.hard_stop.reasons).toContain("evaluation case failed: case-regression-read");
  });
});
