import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyApproval } from "../src/approval.js";
import { runEvaluationSuite } from "../src/evaluation.js";
import { transitionProposal, validateProposal } from "../src/improvement.js";
import { sha256, writeJsonAtomic } from "../src/json.js";
import { DisabledOptimizerAdapter } from "../src/optimizer.js";
import { repositoryPathUri } from "../src/repository.js";
import type { ApprovalDecision, EvaluationSuite, ImprovementProposal } from "../src/types.js";

const fixture = (...parts: string[]): string => resolve(import.meta.dirname, "fixtures", ...parts);

async function readFixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(fixture(...parts), "utf8")) as T;
}

describe("human-governed improvement workflow", () => {
  it("verifies an exact, current candidate approval", async () => {
    const approval = await readFixture<ApprovalDecision>("approvals", "candidate-approved.json");
    await expect(
      verifyApproval(approval, {
        action: "apply_optimization_candidate",
        scope: "prop-eval-safety",
        candidateSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        at: new Date("2026-08-27T13:07:00.000Z"),
      }),
    ).resolves.toEqual(approval);
    await expect(
      verifyApproval(approval, {
        action: "apply_optimization_candidate",
        scope: "prop-eval-safety",
        candidateSha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        at: new Date("2026-08-27T13:07:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  });

  it("rejects wrong approval action, scope, status, and expiry", async () => {
    const approval = await readFixture<ApprovalDecision>("approvals", "candidate-approved.json");
    const expectation = {
      action: "apply_optimization_candidate" as const,
      scope: "prop-eval-safety",
      candidateSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      at: new Date("2026-08-27T13:07:00.000Z"),
    };

    await expect(verifyApproval(approval, { ...expectation, scope: "prop-other" })).rejects.toMatchObject({
      code: "APPROVAL_DENIED",
    });
    await expect(
      verifyApproval(approval, { ...expectation, action: "send_data_externally" }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    await expect(
      verifyApproval({ ...approval, decision: "rejected" }, expectation),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    await expect(
      verifyApproval(approval, { ...expectation, at: new Date("2027-08-27T12:30:00.000Z") }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  });

  it("allows the next lifecycle transition but requires a human at human_reviewed", async () => {
    const observed = await readFixture<ImprovementProposal>("proposals", "observed.json");
    const normalized = await transitionProposal(observed, {
      to: "normalized",
      actor: { kind: "dsh-agent", id: "agent-local" },
      at: new Date("2026-08-27T14:01:00.000Z"),
      evidence: ["repo://tests/fixtures/feedback/completed.json"],
      notes: "Normalize the observed issue.",
    });
    expect(normalized.stage).toBe("normalized");
    await expect(
      transitionProposal(normalized, {
        to: "human_reviewed",
        actor: { kind: "dsh-agent", id: "agent-local" },
        at: new Date("2026-08-27T14:02:00.000Z"),
        evidence: ["repo://docs/governance.md"],
        notes: "Attempt automated review.",
      }),
    ).rejects.toMatchObject({ code: "TRANSITION_DENIED" });
  });

  it("blocks proposal progression when its scorecard is a hard stop", async () => {
    const proposal = await readFixture<ImprovementProposal>("proposals", "proposed-hard-stop.json");
    await expect(validateProposal(proposal)).resolves.toEqual(proposal);
    await expect(
      transitionProposal(proposal, {
        to: "sandbox_evaluated",
        actor: { kind: "dsh-agent", id: "agent-local" },
        at: new Date("2026-08-27T14:14:00.000Z"),
        evidence: ["repo://.dal/evaluations/prop-eval-safety-scorecard.json"],
        notes: "Attempt progression after a hard stop.",
      }),
    ).rejects.toMatchObject({ code: "PROPOSAL_SEMANTIC_INVALID" });
  });

  it("rejects self-reported passing evaluation fields without exact scorecard evidence", async () => {
    const proposal = await readFixture<ImprovementProposal>("proposals", "proposed-hard-stop.json");
    proposal.stage = "sandbox_evaluated";
    proposal.history.push({
      from: "proposed",
      to: "sandbox_evaluated",
      actor: { kind: "dsh-agent", id: "agent-local" },
      at: "2026-08-27T14:14:00.000Z",
      evidence: ["repo://.dal/evaluations/missing-scorecard.json"],
      notes: "Claim passing evidence without a scorecard.",
    });
    proposal.evaluation = {
      environment: "sandbox",
      receipt_uri: "repo://.dal/evaluations/missing-receipt.json",
      scorecard_uri: "repo://.dal/evaluations/missing-scorecard.json",
      scorecard_sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      scorecard_result: "pass",
      metric: "task_success_rate",
      baseline_score: 1,
      candidate_score: 1,
      regression_detected: false,
      evidence: ["repo://.dal/evaluations/missing-scorecard.json"],
    };

    await expect(validateProposal(proposal)).rejects.toMatchObject({ code: "PROPOSAL_SEMANTIC_INVALID" });
  });

  it("accepts evaluated progression only when scorecard file, digest, and candidate all match", async () => {
    const proposal = await readFixture<ImprovementProposal>("proposals", "proposed-hard-stop.json");
    const identifier = randomUUID();
    const candidateUri = `repo://.dal/candidates/${identifier}.json`;
    const candidatePath = resolve(import.meta.dirname, "..", ".dal", "candidates", `${identifier}.json`);
    await writeJsonAtomic(candidatePath, {
      proposal_id: proposal.proposal_id,
      change: "Synthetic bounded candidate for scorecard binding proof.",
    });
    const candidateDigest = sha256(await readFile(candidatePath));
    proposal.candidate = {
      format: "bounded_edits",
      artifact_uri: candidateUri,
      sha256: candidateDigest,
      edit_count: 1,
    };

    const sourceSuitePath = fixture("evaluation", "v0-suite.json");
    const suite = await readFixture<EvaluationSuite>("evaluation", "v0-suite.json");
    suite.suite_id = `suite-proposal-${identifier}`;
    suite.target = {
      kind: "optimizer_proposal",
      id: proposal.proposal_id,
      uri: candidateUri,
      sha256: candidateDigest,
    };
    for (const testCase of suite.cases) {
      testCase.fixture.local_path = resolve(dirname(sourceSuitePath), testCase.fixture.local_path);
    }
    const suitePath = resolve(import.meta.dirname, "..", ".dal", "test-suites", `proposal-${identifier}.json`);
    await writeJsonAtomic(suitePath, suite);
    const scorecardStore = resolve(import.meta.dirname, "..", ".dal", "test-scorecards");
    const run = await runEvaluationSuite(suitePath, scorecardStore);
    const scorecardUri = repositoryPathUri(run.path, "Proposal scorecard");
    const scorecardDigest = sha256(await readFile(run.path));

    proposal.stage = "sandbox_evaluated";
    proposal.history.push({
      from: "proposed",
      to: "sandbox_evaluated",
      actor: { kind: "dsh-agent", id: "agent-local" },
      at: "2026-08-27T14:14:00.000Z",
      evidence: [scorecardUri],
      notes: "Bind the proposal to exact passing scorecard evidence.",
    });
    proposal.evaluation = {
      environment: "sandbox",
      receipt_uri: "repo://.dal/evaluations/proposal-receipt.json",
      scorecard_uri: scorecardUri,
      scorecard_sha256: scorecardDigest,
      scorecard_result: "pass",
      metric: "task_success_rate",
      baseline_score: 1,
      candidate_score: run.scorecard.metrics.task_success_rate,
      regression_detected: false,
      evidence: [scorecardUri],
    };

    await expect(validateProposal(proposal)).resolves.toEqual(proposal);
  });

  it("prepares but never runs or applies optimizer work", async () => {
    const adapter = new DisabledOptimizerAdapter();
    const exchange = {
      $schema: "https://recursive-dev-loop.dev/schemas/optimizer-exchange.v1.schema.json",
      schema_version: "1.0.0",
      exchange_id: "opt-disabled-example",
      mode: "prepare_only",
      provider_hint: null,
      target: {
        kind: "harness_rule",
        artifact_uri: "repo://AGENTS.md",
        base_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        format: "bounded_edits",
      },
      objective: { goal: "Prepare an inert candidate exchange.", metrics: ["task-success"], higher_is_better: true },
      datasets: {
        train: ["repo://tests/fixtures/feedback/completed.json"],
        validation: ["repo://tests/fixtures/evaluation/v0-suite.json"],
        test: [],
      },
      budget: {
        max_evaluations: 1,
        max_candidates: 1,
        max_wall_time_seconds: 60,
        max_external_cost_usd: 0,
      },
      privacy: { classification: "internal", external_transfer_approved: false, approval_ref: null },
      result: null,
    };

    const prepared = await adapter.prepare(exchange);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(() => adapter.optimize()).toThrowError(expect.objectContaining({ code: "OPTIMIZER_DISABLED" }));
    expect(() => adapter.apply()).toThrowError(expect.objectContaining({ code: "CANDIDATE_APPLICATION_DISABLED" }));
  });

  it("rejects any proposal whose surface is an immutable anchor", async () => {
    const proposal = await readFixture<ImprovementProposal>("proposals", "observed.json");
    proposal.target.surface = "evaluator";
    await expect(validateProposal(proposal)).rejects.toMatchObject({ code: "PROPOSAL_SEMANTIC_INVALID" });
  });

  it("requires a falsifiable prediction from the proposed stage onward", async () => {
    const withoutPrediction = await readFixture<ImprovementProposal>("proposals", "proposed-hard-stop.json");
    withoutPrediction.prediction = null;
    await expect(validateProposal(withoutPrediction)).rejects.toMatchObject({ code: "PROPOSAL_SEMANTIC_INVALID" });

    const earlyPrediction = await readFixture<ImprovementProposal>("proposals", "observed.json");
    earlyPrediction.prediction = {
      statement: "Premature prediction.",
      improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }],
      regressions: [],
    };
    await expect(validateProposal(earlyPrediction)).rejects.toMatchObject({ code: "PROPOSAL_SEMANTIC_INVALID" });
  });
});
