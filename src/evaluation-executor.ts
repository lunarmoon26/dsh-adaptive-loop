import { readFile } from "node:fs/promises";

import { DalError } from "./errors.js";
import { resolveEvaluationFixturePath } from "./evaluation-contract.js";
import { validateFeedback } from "./feedback.js";
import { evaluateGuardrailAction } from "./guardrail.js";
import { sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import type { EvaluationEffect, EvaluationSuite, Policy } from "./types.js";

export interface EvaluationObservedResult {
  effect: EvaluationEffect;
  code: string | null;
}

export async function replayEvaluationCases(
  suite: EvaluationSuite,
  suitePath: string,
  policy: Policy,
): Promise<EvaluationObservedResult[]> {
  const results: EvaluationObservedResult[] = [];
  for (const testCase of suite.cases) {
    results.push(await runEvaluationCase(testCase, suitePath, policy));
  }
  return results;
}

export async function runEvaluationCase(
  testCase: EvaluationSuite["cases"][number],
  suitePath: string,
  policy: Policy,
): Promise<EvaluationObservedResult> {
  try {
    const fixturePath = await resolveEvaluationFixturePath(testCase, suitePath);
    const raw = await readFile(fixturePath);
    if (sha256(raw) !== testCase.fixture.sha256) {
      return { effect: "rejected", code: "FIXTURE_DIGEST_MISMATCH" };
    }
    const rawText = raw.toString("utf8");
    assertNoSecrets(scanSecrets({}, rawText));
    assertNoPii(scanPii({}, rawText));
    let value: unknown;
    try {
      value = JSON.parse(rawText) as unknown;
    } catch {
      return { effect: "rejected", code: "INVALID_JSON" };
    }

    if (testCase.kind === "feedback") {
      await validateFeedback(value, policy, rawText);
      return { effect: "allowed", code: null };
    }
    const decision = await evaluateGuardrailAction(value, undefined, new Date(), policy);
    if (decision.effect === "allowed") return { effect: "allowed", code: null };
    const rule = decision.matched_rules.find((entry) => entry.effect === decision.effect);
    return {
      effect: decision.effect === "denied" ? "rejected" : "requires_human_approval",
      code: rule?.id ?? "POLICY_REJECTED",
    };
  } catch (error) {
    if (error instanceof DalError) {
      return { effect: "rejected", code: error.code };
    }
    throw error;
  }
}
