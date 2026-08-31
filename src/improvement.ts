import { readFile } from "node:fs/promises";

import { verifyApproval, validateApprovalDecision } from "./approval.js";
import { DalError } from "./errors.js";
import { validateEvaluationScorecard } from "./evaluation-contract.js";
import { readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertNoSymlinkTraversal, resolveRepositoryUri } from "./repository.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type {
  Actor,
  ApprovalDecision,
  ImprovementProposal,
  ProposalStage,
} from "./types.js";
import { IMMUTABLE_ANCHORS } from "./types.js";

const NEXT_STAGES: Record<ProposalStage, readonly ProposalStage[]> = {
  observed: ["normalized"],
  normalized: ["human_reviewed"],
  human_reviewed: ["proposed"],
  proposed: ["sandbox_evaluated"],
  sandbox_evaluated: ["awaiting_decision"],
  awaiting_decision: ["approved", "rejected"],
  approved: ["applied"],
  rejected: [],
  applied: ["measured"],
  measured: [],
};

const HUMAN_STAGES = new Set<ProposalStage>(["human_reviewed", "approved", "rejected"]);
const CANDIDATE_STAGES = new Set<ProposalStage>([
  "proposed",
  "sandbox_evaluated",
  "awaiting_decision",
  "approved",
  "rejected",
  "applied",
  "measured",
]);
const EVALUATED_STAGES = new Set<ProposalStage>([
  "sandbox_evaluated",
  "awaiting_decision",
  "approved",
  "rejected",
  "applied",
  "measured",
]);
const DECIDED_STAGES = new Set<ProposalStage>(["approved", "rejected", "applied", "measured"]);

export interface TransitionOptions {
  to: ProposalStage;
  actor: Actor;
  at?: Date;
  evidence: string[];
  notes: string;
  decision?: ApprovalDecision;
}

export async function readProposalFile(filePath: string): Promise<ImprovementProposal> {
  const { value, raw } = await readJsonFile<unknown>(filePath);
  assertNoSecrets(scanSecrets(value, raw.toString("utf8")));
  assertNoPii(scanPii(value, raw.toString("utf8")));
  return validateProposal(value);
}

export async function validateProposal(value: unknown): Promise<ImprovementProposal> {
  await assertSchema(SCHEMA_IDS.proposal, value, "Improvement proposal");
  const proposal = value as ImprovementProposal;
  const issues: string[] = [];
  const first = proposal.history[0];

  if (first === undefined || first.from !== null || first.to !== "observed") {
    issues.push("/history must begin with a null -> observed transition");
  }

  let previousStage: ProposalStage | null = null;
  let previousTime = Date.parse(proposal.created_at);
  proposal.history.forEach((transition, index) => {
    const transitionTime = Date.parse(transition.at);
    if (transition.from !== previousStage) {
      issues.push(`/history/${index}/from must equal the preceding stage`);
    }
    if (previousStage === null) {
      if (transition.to !== "observed") {
        issues.push(`/history/${index}/to must initialize observed`);
      }
    } else if (!NEXT_STAGES[previousStage].includes(transition.to)) {
      issues.push(`/history/${index} is not an allowed ${previousStage} -> ${transition.to} transition`);
    }
    if (transitionTime < previousTime) {
      issues.push(`/history/${index}/at must be chronological`);
    }
    if (HUMAN_STAGES.has(transition.to) && transition.actor.kind !== "human") {
      issues.push(`/history/${index}/actor must be human for ${transition.to}`);
    }
    previousTime = transitionTime;
    previousStage = transition.to;
  });

  if (previousStage !== proposal.stage) {
    issues.push("/stage must equal the final history transition");
  }
  if (IMMUTABLE_ANCHORS.includes(proposal.target.surface as (typeof IMMUTABLE_ANCHORS)[number])) {
    issues.push(`/target/surface ${proposal.target.surface} is an immutable anchor the proposer cannot control`);
  }
  if (CANDIDATE_STAGES.has(proposal.stage) && proposal.prediction === null) {
    issues.push(`/prediction is required at stage ${proposal.stage}`);
  }
  if (!CANDIDATE_STAGES.has(proposal.stage) && proposal.prediction !== null) {
    issues.push("/prediction must be null before the proposed stage");
  }
  if (CANDIDATE_STAGES.has(proposal.stage) && proposal.candidate === null) {
    issues.push(`/candidate is required at stage ${proposal.stage}`);
  }
  if (EVALUATED_STAGES.has(proposal.stage) && proposal.evaluation === null) {
    issues.push(`/evaluation is required at stage ${proposal.stage}`);
  }
  if (
    EVALUATED_STAGES.has(proposal.stage) &&
    proposal.evaluation !== null &&
    (proposal.evaluation.scorecard_result !== "pass" || proposal.evaluation.regression_detected)
  ) {
    issues.push(`/evaluation must have a passing scorecard with no regression at stage ${proposal.stage}`);
  }
  if (DECIDED_STAGES.has(proposal.stage) && proposal.decision_ref === null) {
    issues.push(`/decision_ref is required at stage ${proposal.stage}`);
  }
  if (!DECIDED_STAGES.has(proposal.stage) && proposal.decision_ref !== null) {
    issues.push(`/decision_ref must be null before a decision stage`);
  }
  if (proposal.stage === "measured" && proposal.measurements.length === 0) {
    issues.push("/measurements requires at least one measurement at stage measured");
  }
  if (proposal.evaluation !== null) {
    const lowerIsBetter =
      proposal.evaluation.metric === "human_override_rate" ||
      proposal.evaluation.metric === "post_change_regression_rate";
    const observedRegression = lowerIsBetter
      ? proposal.evaluation.candidate_score > proposal.evaluation.baseline_score
      : proposal.evaluation.candidate_score < proposal.evaluation.baseline_score;
    if (observedRegression !== proposal.evaluation.regression_detected) {
      issues.push("/evaluation/regression_detected does not match baseline and candidate scores");
    }
  }
  if (issues.length === 0 && EVALUATED_STAGES.has(proposal.stage)) {
    issues.push(...(await scorecardIssues(proposal)));
  }

  if (issues.length > 0) {
    throw new DalError("PROPOSAL_SEMANTIC_INVALID", "Improvement proposal violates lifecycle rules", issues);
  }
  assertNoSecrets(scanSecrets(proposal));
  assertNoPii(scanPii(proposal));
  return proposal;
}

async function scorecardIssues(proposal: ImprovementProposal): Promise<string[]> {
  if (proposal.candidate === null || proposal.evaluation === null) {
    return [];
  }
  try {
    const path = resolveRepositoryUri(proposal.evaluation.scorecard_uri, "Proposal scorecard URI");
    await assertNoSymlinkTraversal(path, "PROPOSAL_SCORECARD_INVALID", "Proposal scorecard");
    const { value, raw } = await readJsonFile<unknown>(path);
    const scorecard = await validateEvaluationScorecard(value);
    const issues: string[] = [];
    const candidatePath = resolveRepositoryUri(proposal.candidate.artifact_uri, "Proposal candidate URI");
    await assertNoSymlinkTraversal(candidatePath, "PROPOSAL_SCORECARD_INVALID", "Proposal candidate");
    if (sha256(await readFile(candidatePath)) !== proposal.candidate.sha256) {
      issues.push("/candidate/sha256 does not match the candidate artifact file");
    }
    if (sha256(raw) !== proposal.evaluation.scorecard_sha256) {
      issues.push("/evaluation/scorecard_sha256 does not match the scorecard file");
    }
    if (scorecard.result !== proposal.evaluation.scorecard_result) {
      issues.push("/evaluation/scorecard_result does not match the scorecard file");
    }
    if (
      scorecard.target.kind !== "optimizer_proposal" ||
      scorecard.target.id !== proposal.proposal_id ||
      scorecard.target.uri !== proposal.candidate.artifact_uri ||
      scorecard.target.sha256 !== proposal.candidate.sha256
    ) {
      issues.push("/evaluation scorecard target does not match the exact proposal candidate");
    }
    const metric = proposal.evaluation.metric as keyof typeof scorecard.metrics;
    if (!(metric in scorecard.metrics) || scorecard.metrics[metric] !== proposal.evaluation.candidate_score) {
      issues.push("/evaluation candidate score does not match the named scorecard metric");
    }
    return issues;
  } catch (error) {
    if (error instanceof DalError) {
      return [`/evaluation scorecard evidence is invalid: ${error.code}`];
    }
    throw error;
  }
}

export async function transitionProposal(
  value: unknown,
  options: TransitionOptions,
): Promise<ImprovementProposal> {
  const proposal = await validateProposal(value);
  if (!NEXT_STAGES[proposal.stage].includes(options.to)) {
    throw new DalError(
      "TRANSITION_DENIED",
      `Transition ${proposal.stage} -> ${options.to} is not allowed`,
    );
  }
  if (HUMAN_STAGES.has(options.to) && options.actor.kind !== "human") {
    throw new DalError("TRANSITION_DENIED", `Transition to ${options.to} requires a human actor`);
  }

  const at = options.at ?? new Date();
  if (Number.isNaN(at.getTime())) {
    throw new DalError("TRANSITION_DENIED", "Transition time is invalid");
  }
  const last = proposal.history.at(-1);
  if (last !== undefined && at.getTime() < Date.parse(last.at)) {
    throw new DalError("TRANSITION_DENIED", "Transition time precedes proposal history");
  }

  const next = structuredClone(proposal);
  if (options.to === "approved" || options.to === "rejected") {
    if (options.decision === undefined) {
      throw new DalError("TRANSITION_DENIED", `Transition to ${options.to} requires a decision record`);
    }
    const decision = await validateApprovalDecision(options.decision);
    assertProposalDecision(decision, next, options.to, options.actor, at);
    next.decision_ref = decision.decision_id;
  } else if (options.to === "applied") {
    if (options.decision === undefined || next.candidate === null) {
      throw new DalError("TRANSITION_DENIED", "Transition to applied requires the candidate approval record");
    }
    const decision = await verifyApproval(options.decision, {
      action: "apply_optimization_candidate",
      scope: next.proposal_id,
      candidateSha256: next.candidate.sha256,
      at,
    });
    if (decision.decision_id !== next.decision_ref) {
      throw new DalError("TRANSITION_DENIED", "Application decision does not match proposal decision_ref");
    }
  } else if (options.decision !== undefined) {
    throw new DalError("TRANSITION_DENIED", `Transition to ${options.to} does not consume a decision record`);
  }

  next.history.push({
    from: next.stage,
    to: options.to,
    actor: structuredClone(options.actor),
    at: at.toISOString(),
    evidence: [...options.evidence],
    notes: options.notes,
  });
  next.stage = options.to;
  return validateProposal(next);
}

function assertProposalDecision(
  decision: ApprovalDecision,
  proposal: ImprovementProposal,
  target: "approved" | "rejected",
  actor: Actor,
  at: Date,
): void {
  const issues: string[] = [];
  if (decision.action !== "apply_optimization_candidate") {
    issues.push("decision action must be apply_optimization_candidate");
  }
  if (decision.scope.value !== proposal.proposal_id || decision.scope.kind !== "proposal") {
    issues.push("decision scope must identify the exact proposal");
  }
  if (proposal.candidate === null || decision.candidate_sha256 !== proposal.candidate.sha256) {
    issues.push("decision candidate digest must match the proposal candidate");
  }
  if (decision.decision !== target) {
    issues.push(`decision value must be ${target}`);
  }
  if (actor.kind !== "human" || actor.id !== decision.reviewer.id) {
    issues.push("transition actor must be the decision reviewer");
  }
  if (Date.parse(decision.decided_at) > at.getTime()) {
    issues.push("transition cannot precede the human decision");
  }
  if (target === "approved" && at.getTime() >= Date.parse(decision.expires_at)) {
    issues.push("approved decision has expired");
  }
  if (issues.length > 0) {
    throw new DalError("TRANSITION_DENIED", `Decision does not support transition to ${target}`, issues);
  }
}
