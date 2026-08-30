import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runEvaluationSuite } from "../src/evaluation.js";
import { evaluateGuardrailAction, recordGuardrailDecision } from "../src/guardrail.js";
import { sha256 } from "../src/json.js";
import { repositoryPathUri } from "../src/repository.js";
import { loadPolicy } from "../src/schema.js";
import type { ApprovalDecision, EvaluationSuite, GuardrailAction } from "../src/types.js";

const fixture = (...parts: string[]): string => resolve(import.meta.dirname, "fixtures", ...parts);

async function readFixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(fixture(...parts), "utf8")) as T;
}

async function publishQuarantineScorecard(
  target: EvaluationSuite["target"],
  store: string,
): Promise<void> {
  const sourceSuitePath = fixture("evaluation", "v0-suite.json");
  const suite = await readFixture<EvaluationSuite>("evaluation", "v0-suite.json");
  const identifier = randomUUID();
  suite.suite_id = `suite-quarantine-${identifier}`;
  suite.target = target;
  for (const testCase of suite.cases) {
    testCase.fixture.local_path = resolve(dirname(sourceSuitePath), testCase.fixture.local_path);
  }
  const action = await readFixture<GuardrailAction>("guardrail", "adversarial-read.json");
  action.action_id = `act-quarantine-replay-${identifier}`;
  action.target = {
    uri: target.uri,
    artifact_kind: "other",
    artifact_id: target.id,
    sha256: target.sha256,
  };
  const actionRoot = resolve(import.meta.dirname, "..", ".dal", "test-actions");
  await mkdir(actionRoot, { recursive: true });
  const actionPath = join(actionRoot, `quarantine-${identifier}.json`);
  await writeFile(actionPath, `${JSON.stringify(action, null, 2)}\n`, "utf8");
  const replayCase = suite.cases.find((testCase) => testCase.id === "case-adversarial-instruction")!;
  replayCase.fixture = {
    uri: repositoryPathUri(actionPath, "Quarantine replay action"),
    local_path: actionPath,
    sha256: sha256(await readFile(actionPath)),
  };
  suite.cases.find((testCase) => testCase.id === "case-offline-feedback")!.expected_effect = "rejected";
  const suiteRoot = resolve(import.meta.dirname, "..", ".dal", "test-suites");
  await mkdir(suiteRoot, { recursive: true });
  const suitePath = join(suiteRoot, `quarantine-${identifier}.json`);
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");

  const result = await runEvaluationSuite(suitePath, store);
  expect(result.scorecard.result).toBe("hard_stop");
  expect(result.scorecard.hard_stop.disposition).toBe("quarantine");
}

describe("deterministic guardrails", () => {
  it("allows only a declared local read", async () => {
    const action = await readFixture<GuardrailAction>("guardrail", "allowed-read.json");
    const decision = await evaluateGuardrailAction(action);

    expect(decision.effect).toBe("allowed");
    expect(decision.matched_rules.map((rule) => rule.id)).toContain("capability-allowed");
  });

  it("denies a request whose declared budget exceeds policy", async () => {
    const action = await readFixture<GuardrailAction>("guardrail", "allowed-read.json");
    action.budget.max_calls = 65;
    const decision = await evaluateGuardrailAction(action);

    expect(decision.effect).toBe("denied");
    expect(decision.matched_rules.map((rule) => rule.id)).toContain("budget-exceeded");
  });

  it.each([
    ["read_local", "repo://../../outside", "read-root-denied"],
    ["write_local_evidence", "repo://.dal/../outside", "write-root-denied"],
    ["write_local_evidence", "repo://.dal/%2e%2e/outside", "write-root-denied"],
  ] as const)("denies non-canonical %s repository paths", async (capability, uri, rule) => {
    const action = await readFixture<GuardrailAction>(
      "guardrail",
      capability === "read_local" ? "allowed-read.json" : "allowed-write.json",
    );
    action.target.uri = uri;
    const decision = await evaluateGuardrailAction(action);

    expect(decision.effect).toBe("denied");
    expect(decision.matched_rules.map((entry) => entry.id)).toEqual(expect.arrayContaining(["target-uri-denied", rule]));
  });

  it("requires exact approval for an unapproved candidate without changing the target", async () => {
    const actionPath = fixture("guardrail", "unapproved-candidate.json");
    const targetPath = fixture("proposals", "proposed-hard-stop.json");
    const before = await readFile(targetPath);
    const action = await readFixture<GuardrailAction>("guardrail", "unapproved-candidate.json");
    const decision = await evaluateGuardrailAction(action);

    expect(decision.effect).toBe("requires_human_approval");
    expect(decision.matched_rules.map((rule) => rule.id)).toContain("approval-required");
    expect(await readFile(targetPath)).toEqual(before);
    expect(await readFile(actionPath)).not.toEqual(Buffer.alloc(0));
  });

  it("keeps candidate execution disabled after exact approval", async () => {
    const action = await readFixture<GuardrailAction>("guardrail", "approved-candidate.json");
    const approval = await readFixture<ApprovalDecision>("approvals", "candidate-approved.json");
    const decision = await evaluateGuardrailAction(
      action,
      approval,
      new Date("2026-08-27T13:07:00.000Z"),
    );

    expect(decision.effect).toBe("denied");
    expect(decision.matched_rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(["approval-verified", "v0-executor-disabled"]),
    );
  });

  it("writes an immutable audit record and rejects an action-ID conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-guardrail-audit-"));
    const store = join(root, "store");
    const actionPath = fixture("guardrail", "allowed-read.json");
    const first = await recordGuardrailDecision(actionPath, undefined, store);
    const repeated = await recordGuardrailDecision(actionPath, undefined, store);
    const changed = await readFixture<GuardrailAction>("guardrail", "allowed-read.json");
    changed.budget.max_bytes_read += 1;
    const changedPath = join(root, "changed.json");
    await writeFile(changedPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    expect(first.status).toBe("stored");
    expect(repeated.status).toBe("idempotent");
    await expect(recordGuardrailDecision(changedPath, undefined, store)).rejects.toMatchObject({
      code: "GUARDRAIL_ID_CONFLICT",
    });
  });

  it("rejects stale idempotence after new quarantine evidence changes the decision", async () => {
    const identifier = randomUUID();
    const artifactRoot = resolve(import.meta.dirname, "..", ".dal", "test-artifacts");
    await mkdir(artifactRoot, { recursive: true });
    const artifactPath = join(artifactRoot, `${identifier}.json`);
    await writeFile(artifactPath, `${JSON.stringify({ identifier })}\n`, "utf8");
    const artifactUri = `repo://.dal/test-artifacts/${identifier}.json`;
    const digest = sha256(await readFile(artifactPath));
    const root = await mkdtemp(join(tmpdir(), "dal-guardrail-stale-"));
    const action = await readFixture<GuardrailAction>("guardrail", "allowed-read.json");
    action.action_id = `act-stale-${identifier}`;
    action.target = {
      uri: artifactUri,
      artifact_kind: "other",
      artifact_id: `artifact-${identifier}`,
      sha256: digest,
    };
    const actionPath = join(root, "action.json");
    await writeFile(actionPath, `${JSON.stringify(action, null, 2)}\n`, "utf8");
    const auditStore = join(root, "audit");
    expect((await recordGuardrailDecision(actionPath, undefined, auditStore)).decision.effect).toBe("allowed");

    const policy = await loadPolicy();
    await publishQuarantineScorecard(
      {
      kind: "rdl_runtime",
      id: `artifact-${identifier}`,
      uri: artifactUri,
      sha256: digest,
      },
      resolve(import.meta.dirname, "..", policy.default_evaluation_store),
    );

    await expect(recordGuardrailDecision(actionPath, undefined, auditStore)).rejects.toMatchObject({
      code: "GUARDRAIL_DECISION_STALE",
    });
  });

  it("fails closed for a digest marked by an immutable quarantine scorecard", async () => {
    const evaluationStore = await mkdtemp(join(tmpdir(), "dal-quarantine-"));
    const action = await readFixture<GuardrailAction>("guardrail", "allowed-read.json");
    const digest = sha256(await readFile(fixture("guardrail", "allowed-read.json")));
    action.target = {
      uri: "repo://tests/fixtures/guardrail/allowed-read.json",
      artifact_kind: "other",
      artifact_id: "artifact-quarantine-test",
      sha256: digest,
    };
    await publishQuarantineScorecard(
      {
        kind: "rdl_runtime",
        id: "artifact-quarantine-test",
        uri: action.target.uri,
        sha256: digest,
      },
      evaluationStore,
    );
    const policy = { ...(await loadPolicy()), default_evaluation_store: evaluationStore };

    const decision = await evaluateGuardrailAction(action, undefined, new Date(), policy);
    expect(decision.effect).toBe("denied");
    expect(decision.matched_rules.map((rule) => rule.id)).toContain("artifact-quarantined");
  });
});
