#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateApprovalDecision, verifyApprovalFile } from "./approval.js";
import { admissionStatus, completeAdmission, issueAdmission } from "./admission.js";
import { branchStats, evaluateBranch, recordBranch, selectBranchUcb } from "./branch.js";
import { checkCapsulePath } from "./capsule.js";
import { clusterRunRecords } from "./clustering.js";
import { DalError } from "./errors.js";
import { runEvaluationSuite } from "./evaluation.js";
import { runVerifier } from "./executor.js";
import { validateFeedbackDocument } from "./feedback.js";
import { recordGuardrailDecision } from "./guardrail.js";
import { readProposalFile, transitionProposal } from "./improvement.js";
import { initWorkspace } from "./init.js";
import { installUserGlobal } from "./install.js";
import { evaluateOptimizerCandidate, prepareOptimizerExchange } from "./optimizer-adapter.js";
import { publishJsonExclusive, readJsonFile, sha256, writeJsonAtomic } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { prepareProposePayload, runPropose } from "./propose.js";
import { resetExecute, resetStatus } from "./reset.js";
import {
  assertNoSymlinkTraversal,
  prepareSafeRepositoryDirectory,
  resolveDedicatedRepositoryWritePath,
} from "./repository.js";
import { ingestRunRecord } from "./runs.js";
import { beginSaga, completeSaga, listSagas, sagaStatus, SAGA_ACTIONS, type SagaAction } from "./saga.js";
import { loadPolicy } from "./schema.js";
import { sealInit, sealReveal, sealVerify } from "./seal.js";
import { ingestFeedback, queryFeedback, summarizeFeedback, type FeedbackQuery } from "./store.js";
import {
  PROPOSAL_STAGES,
  SENSITIVE_ACTIONS,
  type ActorKind,
  type ApprovalDecision,
  type FeedbackOutcome,
  type ProposalStage,
  type SensitiveAction,
} from "./types.js";

interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string[]>;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  try {
    await dispatch(argv, io);
    return 0;
  } catch (error) {
    if (error instanceof DalError) {
      io.stderr(`${error.code}: ${error.message}\n`);
      for (const issue of error.issues) {
        io.stderr(`- ${issue}\n`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`UNEXPECTED_ERROR: ${message}\n`);
    return 1;
  }
}

async function dispatch(argv: readonly string[], io: CliIo): Promise<void> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(HELP);
    return;
  }

  const [group, action, ...rest] = argv;
  if (group === "feedback" && action === "validate") {
    await feedbackValidate(rest, io);
    return;
  }
  if (group === "feedback" && action === "ingest") {
    await feedbackIngest(rest, io);
    return;
  }
  if (group === "feedback" && action === "query") {
    await feedbackQuery(rest, io);
    return;
  }
  if (group === "feedback" && action === "summary") {
    await feedbackSummary(rest, io);
    return;
  }
  if (group === "capsule" && action === "check") {
    await capsuleCheck(rest, io);
    return;
  }
  if (group === "approval" && action === "verify") {
    await approvalVerify(rest, io);
    return;
  }
  if (group === "policy" && action === "check") {
    await policyCheck(rest, io);
    return;
  }
  if (group === "eval" && action === "run") {
    await evaluationRun(rest, io);
    return;
  }
  if (group === "run" && action === "ingest") {
    await runIngest(rest, io);
    return;
  }
  if (group === "cluster" && action === "run") {
    await clusterRun(rest, io);
    return;
  }
  if (group === "improvement" && action === "transition") {
    await improvementTransition(rest, io);
    return;
  }
  if (group === "init") {
    await initCommand(argv.slice(1), io);
    return;
  }
  if (group === "install") {
    await installCommand(argv.slice(1), io);
    return;
  }
  if (group === "seal" && action === "init") {
    await sealInitCommand(rest, io);
    return;
  }
  if (group === "seal" && action === "verify") {
    await sealVerifyCommand(rest, io);
    return;
  }
  if (group === "seal" && action === "reveal") {
    await sealRevealCommand(rest, io);
    return;
  }
  if (group === "saga" && action === "begin") {
    await sagaBeginCommand(rest, io);
    return;
  }
  if (group === "saga" && action === "complete") {
    await sagaCompleteCommand(rest, io);
    return;
  }
  if (group === "saga" && action === "status") {
    await sagaStatusCommand(rest, io);
    return;
  }
  if (group === "saga" && action === "list") {
    await sagaListCommand(rest, io);
    return;
  }
  if (group === "admit" && action === "issue") {
    await admitIssueCommand(rest, io);
    return;
  }
  if (group === "admit" && action === "complete") {
    await admitCompleteCommand(rest, io);
    return;
  }
  if (group === "admit" && action === "status") {
    await admitStatusCommand(rest, io);
    return;
  }
  if (group === "propose" && action === "prepare") {
    await proposePrepareCommand(rest, io);
    return;
  }
  if (group === "propose" && action === "run") {
    await proposeRunCommand(rest, io);
    return;
  }
  if (group === "branch" && action === "record") {
    await branchRecordCommand(rest, io);
    return;
  }
  if (group === "branch" && action === "evaluate") {
    await branchEvaluateCommand(rest, io);
    return;
  }
  if (group === "branch" && action === "stats") {
    await branchStatsCommand(rest, io);
    return;
  }
  if (group === "branch" && action === "select") {
    await branchSelectCommand(rest, io);
    return;
  }
  if (group === "verify" && action === "run") {
    await verifyRunCommand(rest, io);
    return;
  }
  if (group === "optimize" && action === "prepare") {
    await optimizePrepareCommand(rest, io);
    return;
  }
  if (group === "optimize" && action === "evaluate") {
    await optimizeEvaluateCommand(rest, io);
    return;
  }
  if (group === "reset" && action === "status") {
    await resetStatusCommand(rest, io);
    return;
  }
  if (group === "reset" && action === "execute") {
    await resetExecuteCommand(rest, io);
    return;
  }

  throw new DalError("USAGE_ERROR", `Unknown command: ${[group, action].filter(Boolean).join(" ")}`);
}

async function feedbackValidate(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, []);
  const [filePath] = exactlyPositionals(parsed, 1, "feedback validate <file>");
  const { feedback, policy } = await validateFeedbackDocument(filePath!);
  printJson(io, {
    status: "valid",
    feedback_id: feedback.feedback_id,
    schema_version: feedback.schema_version,
    secret_ruleset_version: policy.secret_ruleset_version,
    pii_ruleset_version: policy.pii_ruleset_version,
  });
}

async function feedbackIngest(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store"]);
  const [filePath] = exactlyPositionals(parsed, 1, "feedback ingest <file> [--store <directory>]");
  const result = await ingestFeedback(filePath!, oneOption(parsed, "store"));
  printJson(io, {
    status: result.status,
    feedback_id: result.record.record_id,
    feedback_sha256: result.record.feedback_sha256,
    record_path: displayPath(result.path),
  });
}

async function feedbackQuery(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["feedback", "change", "outcome", "privacy-tag", "from", "to", "store", "format"]);
  exactlyPositionals(parsed, 0, "feedback query [filters]");
  const records = await queryFeedback(queryFrom(parsed), oneOption(parsed, "store"));
  const format = outputFormat(parsed);
  if (format === "json") {
    printJson(io, records);
    return;
  }
  if (records.length === 0) {
    io.stdout("No feedback records matched.\n");
    return;
  }
  for (const record of records) {
    const feedback = record.feedback;
    io.stdout(`${feedback.feedback_id}\t${feedback.change_id}\t${feedback.outcome.status}\t${feedback.created_at}\n`);
  }
}

async function feedbackSummary(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["feedback", "change", "outcome", "privacy-tag", "from", "to", "store", "format"]);
  exactlyPositionals(parsed, 0, "feedback summary [filters]");
  const summary = summarizeFeedback(await queryFeedback(queryFrom(parsed), oneOption(parsed, "store")));
  if (outputFormat(parsed) === "json") {
    printJson(io, summary);
    return;
  }
  io.stdout(`records.total\t${summary.total_records}\n`);
  io.stdout(`outcomes.completed\t${summary.outcomes.completed}\n`);
  io.stdout(`outcomes.blocked\t${summary.outcomes.blocked}\n`);
  io.stdout(`outcomes.aborted\t${summary.outcomes.aborted}\n`);
  io.stdout(`inefficiencies.total\t${summary.inefficiencies.total}\n`);
  for (const [category, count] of Object.entries(summary.inefficiencies.by_category)) {
    io.stdout(`inefficiencies.${category}\t${count}\n`);
  }
}

async function capsuleCheck(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, []);
  const [inputPath] = exactlyPositionals(parsed, 1, "capsule check <path-or-directory>");
  const results = await checkCapsulePath(inputPath!);
  printJson(io, {
    status: "valid",
    capsules: results.map((result) => ({ ...result, path: displayPath(result.path) })),
  });
}

async function approvalVerify(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["action", "scope", "candidate-sha256", "at"]);
  const [filePath] = exactlyPositionals(parsed, 1, "approval verify <decision-file> --action <action> --scope <scope>");
  const action = sensitiveAction(requiredOption(parsed, "action"));
  const scope = requiredOption(parsed, "scope");
  const atValue = oneOption(parsed, "at");
  const expectation: {
    action: SensitiveAction;
    scope: string;
    candidateSha256?: string;
    at?: Date;
  } = { action, scope };
  const candidateSha256 = oneOption(parsed, "candidate-sha256");
  if (candidateSha256 !== undefined) {
    expectation.candidateSha256 = candidateSha256;
  }
  if (atValue !== undefined) {
    expectation.at = parseDate(atValue, "at");
  }
  const decision = await verifyApprovalFile(filePath!, expectation);
  printJson(io, {
    status: "approved",
    decision_id: decision.decision_id,
    action: decision.action,
    scope_sha256: decision.scope.sha256,
    expires_at: decision.expires_at,
  });
}

async function policyCheck(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["approval", "store"]);
  const [filePath] = exactlyPositionals(
    parsed,
    1,
    "policy check <action-file> [--approval <decision-file>] [--store <directory>]",
  );
  const result = await recordGuardrailDecision(
    filePath!,
    oneOption(parsed, "approval"),
    oneOption(parsed, "store"),
  );
  printJson(io, {
    status: result.status,
    effect: result.decision.effect,
    action_id: result.decision.request.action_id,
    decision_id: result.decision.decision_id,
    matched_rules: result.decision.matched_rules.map((rule) => rule.id),
    record_path: displayPath(result.path),
  });
  if (result.decision.effect !== "allowed") {
    throw new DalError("POLICY_REJECTED", `Guardrail effect is ${result.decision.effect}`);
  }
}

async function evaluationRun(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store"]);
  const [filePath] = exactlyPositionals(parsed, 1, "eval run <suite-file> [--store <directory>]");
  const result = await runEvaluationSuite(filePath!, oneOption(parsed, "store"));
  printJson(io, {
    status: result.scorecard.result,
    scorecard_id: result.scorecard.scorecard_id,
    metrics: result.scorecard.metrics,
    hard_stop: result.scorecard.hard_stop,
    record_path: displayPath(result.path),
  });
  if (result.scorecard.result === "hard_stop") {
    throw new DalError("EVALUATION_HARD_STOP", "Evaluation triggered quarantine/rollback review");
  }
}

async function runIngest(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store"]);
  const [filePath] = exactlyPositionals(parsed, 1, "run ingest <file> [--store <directory>]");
  const result = await ingestRunRecord(filePath!, oneOption(parsed, "store"));
  printJson(io, {
    status: result.status,
    run_id: result.record.run_id,
    run_sha256: result.run_sha256,
    record_path: displayPath(result.path),
  });
}

async function clusterRun(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store", "output", "format"]);
  exactlyPositionals(parsed, 0, "cluster run [--store <directory>] [--output <directory>] [--format text|json]");
  const options: Parameters<typeof clusterRunRecords>[0] = {};
  const store = oneOption(parsed, "store");
  const output = oneOption(parsed, "output");
  if (store !== undefined) {
    options.store = store;
  }
  if (output !== undefined) {
    options.output = output;
  }
  const result = await clusterRunRecords(options);
  const clusters = result.clusters.map((cluster) => ({
    cluster_id: cluster.cluster_id,
    member_count: cluster.member_count,
    status: cluster.status,
    path: displayPath(cluster.path),
  }));
  if (outputFormat(parsed) === "json") {
    printJson(io, {
      cluster_count: result.cluster_count,
      clustered_runs: result.clustered_runs,
      skipped_successful_runs: result.skipped_successful_runs,
      skipped_unfailed_runs: result.skipped_unfailed_runs,
      clusters,
    });
    return;
  }
  io.stdout(`clusters\t${result.cluster_count}\n`);
  io.stdout(`clustered_runs\t${result.clustered_runs}\n`);
  io.stdout(`skipped_successful_runs\t${result.skipped_successful_runs}\n`);
  io.stdout(`skipped_unfailed_runs\t${result.skipped_unfailed_runs}\n`);
  for (const cluster of clusters) {
    io.stdout(`cluster\t${cluster.cluster_id}\t${cluster.member_count}\t${cluster.status}\n`);
  }
}

async function initCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["dir", "skill"]);
  exactlyPositionals(parsed, 0, "init [--dir <directory>] [--skill <name>]");
  const dir = oneOption(parsed, "dir");
  const skill = oneOption(parsed, "skill");
  const options: Parameters<typeof initWorkspace>[0] = {};
  if (dir !== undefined) {
    options.dir = dir;
  }
  if (skill !== undefined) {
    options.skillName = skill;
  }
  const result = await initWorkspace(options);
  printJson(io, result);
}

async function installCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["approval"]);
  const [mode] = exactlyPositionals(parsed, 1, "install user-global --approval <decision-file>");
  if (mode !== "user-global") {
    throw new DalError("USAGE_ERROR", "Only user-global installs are supported");
  }
  const approval = requiredOption(parsed, "approval");
  const result = await installUserGlobal({ approvalPath: approval });
  printJson(io, result);
}

async function sealInitCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["cases", "output", "holdout", "holdout-cases"]);
  exactlyPositionals(parsed, 0, "seal init --cases <dir> --output <dir> [--holdout <count> | --holdout-cases <dir>]");
  const holdoutValue = oneOption(parsed, "holdout");
  const holdoutCases = oneOption(parsed, "holdout-cases");
  const options: Parameters<typeof sealInit>[0] = {
    casesDir: requiredOption(parsed, "cases"),
    outputDir: requiredOption(parsed, "output"),
  };
  if (holdoutCases !== undefined) {
    options.holdoutCasesDir = holdoutCases;
  }
  if (holdoutValue !== undefined) {
    const holdout = Number(holdoutValue);
    if (!Number.isInteger(holdout) || holdout < 1) {
      throw new DalError("USAGE_ERROR", "Option --holdout must be a positive integer");
    }
    options.holdoutCount = holdout;
  }
  const result = await sealInit(options);
  printJson(io, {
    status: result.status,
    seal_id: result.seal_id,
    observed_cases: result.observed_cases,
    holdout_handles: result.holdout_handles,
    path: displayPath(result.path),
  });
}

async function sealVerifyCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["sealed", "cases", "holdout-cases"]);
  exactlyPositionals(parsed, 0, "seal verify --sealed <dir> --cases <dir> [--holdout-cases <dir>]");
  const options: Parameters<typeof sealVerify>[0] = {
    sealedDir: requiredOption(parsed, "sealed"),
    casesDir: requiredOption(parsed, "cases"),
  };
  const holdoutCases = oneOption(parsed, "holdout-cases");
  if (holdoutCases !== undefined) {
    options.holdoutCasesDir = holdoutCases;
  }
  const result = await sealVerify(options);
  printJson(io, result);
}

async function sealRevealCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["sealed", "candidate"]);
  exactlyPositionals(parsed, 0, "seal reveal --sealed <dir> --candidate <id>");
  const result = await sealReveal({
    sealedDir: requiredOption(parsed, "sealed"),
    candidateId: requiredOption(parsed, "candidate"),
  });
  printJson(io, {
    status: result.status,
    seal_id: result.seal_id,
    candidate_id: result.candidate_id,
    holdout_cases: result.holdout_cases,
    path: displayPath(result.path),
  });
}

async function sagaBeginCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["intent", "action", "payload", "payload-sha256", "store"]);
  exactlyPositionals(parsed, 0, "saga begin --intent <id> --action <effect> --payload <file-or-uri> [--payload-sha256 <digest>]");
  const payloadValue = requiredOption(parsed, "payload");
  const resolved = await resolvePayload(payloadValue, oneOption(parsed, "payload-sha256"), "payload-sha256");
  const options: Parameters<typeof beginSaga>[0] = {
    intentId: requiredOption(parsed, "intent"),
    action: sagaAction(requiredOption(parsed, "action")),
    payloadRef: resolved.ref,
    payloadSha256: resolved.sha256,
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await beginSaga(options);
  printJson(io, {
    status: result.status,
    intent_id: result.intent.intent_id,
    action: result.intent.action,
    record_path: displayPath(result.path),
  });
}

async function sagaCompleteCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["intent", "outcome", "receipt", "receipt-sha256", "store"]);
  exactlyPositionals(parsed, 0, "saga complete --intent <id> --outcome completed|failed --receipt <file-or-uri> [--receipt-sha256 <digest>]");
  const outcome = requiredOption(parsed, "outcome");
  if (outcome !== "completed" && outcome !== "failed") {
    throw new DalError("USAGE_ERROR", "Option --outcome must be completed or failed");
  }
  const receiptValue = requiredOption(parsed, "receipt");
  const resolved = await resolvePayload(receiptValue, oneOption(parsed, "receipt-sha256"), "receipt-sha256");
  const options: Parameters<typeof completeSaga>[0] = {
    intentId: requiredOption(parsed, "intent"),
    outcome,
    receiptRef: resolved.ref,
    receiptSha256: resolved.sha256,
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await completeSaga(options);
  printJson(io, {
    status: result.status,
    intent_id: result.receipt.intent_id,
    outcome: result.receipt.outcome,
    record_path: displayPath(result.path),
  });
}

async function sagaStatusCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["intent", "store"]);
  exactlyPositionals(parsed, 0, "saga status --intent <id>");
  const options: Parameters<typeof sagaStatus>[0] = { intentId: requiredOption(parsed, "intent") };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await sagaStatus(options);
  printJson(io, {
    state: result.state,
    intent_id: result.intent?.intent_id ?? null,
    action: result.intent?.action ?? null,
    outcome: result.receipt?.outcome ?? null,
    receipt_ref: result.receipt?.receipt_ref ?? null,
  });
}

async function sagaListCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store"]);
  exactlyPositionals(parsed, 0, "saga list [--store <directory>]");
  const options: Parameters<typeof listSagas>[0] = {};
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const results = await listSagas(options);
  printJson(
    io,
    results.map((result) => ({
      state: result.state,
      intent_id: result.intent?.intent_id ?? null,
      action: result.intent?.action ?? null,
      outcome: result.receipt?.outcome ?? null,
    })),
  );
}

async function resolvePayload(
  value: string,
  suppliedDigest: string | undefined,
  digestOption: string,
): Promise<{ ref: string; sha256: string }> {
  try {
    await access(value);
    return { ref: pathToFileURL(resolve(process.cwd(), value)).href, sha256: sha256(await readFile(value)) };
  } catch {
    if (suppliedDigest === undefined) {
      throw new DalError("USAGE_ERROR", `Option --${digestOption} is required when the value is not a local file`);
    }
    return { ref: value, sha256: suppliedDigest };
  }
}

function sagaAction(value: string): SagaAction {
  if (!(SAGA_ACTIONS as readonly string[]).includes(value)) {
    throw new DalError("USAGE_ERROR", `Unsupported saga action: ${value}`);
  }
  return value as SagaAction;
}

async function admitIssueCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["admission", "candidate", "candidate-sha256", "store"]);
  exactlyPositionals(parsed, 0, "admit issue --admission <id> --candidate <file-or-uri> [--candidate-sha256 <digest>]");
  const candidateValue = requiredOption(parsed, "candidate");
  const resolved = await resolvePayload(candidateValue, oneOption(parsed, "candidate-sha256"), "candidate-sha256");
  const options: Parameters<typeof issueAdmission>[0] = {
    admissionId: requiredOption(parsed, "admission"),
    candidateRef: resolved.ref,
    candidateSha256: resolved.sha256,
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await issueAdmission(options);
  printJson(io, {
    status: result.status,
    admission_id: result.challenge.admission_id,
    nonce: result.challenge.nonce,
    record_path: displayPath(result.path),
  });
}

async function admitCompleteCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["admission", "result", "store"]);
  exactlyPositionals(parsed, 0, "admit complete --admission <id> --result <result-file>");
  const options: Parameters<typeof completeAdmission>[0] = {
    admissionId: requiredOption(parsed, "admission"),
    resultPath: requiredOption(parsed, "result"),
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await completeAdmission(options);
  printJson(io, {
    status: result.status,
    admission_id: result.receipt.admission_id,
    outcome: result.receipt.outcome,
    record_path: displayPath(result.path),
  });
}

async function admitStatusCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["admission", "store"]);
  exactlyPositionals(parsed, 0, "admit status --admission <id>");
  const options: Parameters<typeof admissionStatus>[0] = { admissionId: requiredOption(parsed, "admission") };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await admissionStatus(options);
  printJson(io, {
    state: result.state,
    admission_id: result.challenge?.admission_id ?? null,
    nonce: result.challenge?.nonce ?? null,
    outcome: result.receipt?.outcome ?? null,
  });
}

async function proposePrepareCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["clusters", "runs", "output"]);
  exactlyPositionals(parsed, 0, "propose prepare --clusters <dir> [--runs <dir>] --output <payload-file>");
  const options: Parameters<typeof prepareProposePayload>[0] = { clustersDir: requiredOption(parsed, "clusters") };
  const runs = oneOption(parsed, "runs");
  if (runs !== undefined) {
    options.runsDir = runs;
  }
  const prepared = await prepareProposePayload(options);
  await publishJsonExclusive(resolve(process.cwd(), requiredOption(parsed, "output")), prepared.payload);
  printJson(io, {
    status: "prepared",
    payload_digest: prepared.digest,
    payload_path: displayPath(resolve(process.cwd(), requiredOption(parsed, "output"))),
  });
}

async function proposeRunCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["clusters", "runs", "approval", "workspace", "output", "provider", "model", "runner"]);
  exactlyPositionals(parsed, 0, "propose run --clusters <dir> [--runs <dir>] --approval <decision> --workspace <dir> --output <draft-file> [--provider <p>] [--model <m>] [--runner local|docker]");
  const options: Parameters<typeof runPropose>[0] = {
    clustersDir: requiredOption(parsed, "clusters"),
    approvalPath: requiredOption(parsed, "approval"),
    workspaceDir: requiredOption(parsed, "workspace"),
    outputPath: requiredOption(parsed, "output"),
    model: {
      provider: oneOption(parsed, "provider") ?? "deepseek-official",
      model: oneOption(parsed, "model") ?? "deepseek-v4-flash",
    },
  };
  const runs = oneOption(parsed, "runs");
  if (runs !== undefined) {
    options.runsDir = runs;
  }
  const runner = runnerValue(oneOption(parsed, "runner"));
  if (runner === "docker") {
    const policy = await loadPolicy();
    options.runner = "docker";
    options.docker = {
      image: policy.docker_image ?? "dsh-adaptive-loop/dsh:0.1.1-rc.2",
      runFlags: policy.docker_run_flags ?? [],
      envNames: policy.docker_env_names ?? [],
    };
  }
  const result = await runPropose(options);
  printJson(io, {
    status: result.status,
    draft_id: result.draft.draft_id,
    surface: result.draft.surface,
    payload_digest: result.payload_digest,
    draft_path: displayPath(result.path),
  });
}

async function branchRecordCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["branch", "parent", "draft", "store"]);
  exactlyPositionals(parsed, 0, "branch record --branch <id> --draft <draft-file> [--parent <branch-id>]");
  const options: Parameters<typeof recordBranch>[0] = {
    branchId: requiredOption(parsed, "branch"),
    parentBranchId: oneOption(parsed, "parent") ?? null,
    draftPath: requiredOption(parsed, "draft"),
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const result = await recordBranch(options);
  printJson(io, {
    status: result.status,
    branch_id: result.branch.branch_id,
    parent_branch_id: result.branch.parent_branch_id,
    surface: result.branch.surface,
    record_path: displayPath(result.path),
  });
}

async function branchEvaluateCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["branch", "task", "state", "store", "receipt"]);
  exactlyPositionals(parsed, 0, "branch evaluate --branch <id> --task <task-file> --state <state-file> [--receipt <file>]");
  const options: Parameters<typeof evaluateBranch>[0] = {
    branchId: requiredOption(parsed, "branch"),
    taskPath: requiredOption(parsed, "task"),
    candidateStatePath: requiredOption(parsed, "state"),
  };
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const receipt = oneOption(parsed, "receipt");
  if (receipt !== undefined) {
    options.receiptPath = receipt;
  }
  const result = await evaluateBranch(options);
  printJson(io, {
    status: result.status,
    evaluation_id: result.evaluation.evaluation_id,
    branch_id: result.evaluation.branch_id,
    task_id: result.evaluation.task_id,
    passed: result.evaluation.passed,
    score: result.evaluation.score,
  });
}

async function branchStatsCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store"]);
  exactlyPositionals(parsed, 0, "branch stats [--store <directory>]");
  const options: Parameters<typeof branchStats>[0] = {};
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const stats = await branchStats(options);
  printJson(io, stats);
}

async function branchSelectCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["store", "c"]);
  exactlyPositionals(parsed, 0, "branch select [--store <directory>] [--c <exploration>]");
  const options: Parameters<typeof branchStats>[0] = {};
  const store = oneOption(parsed, "store");
  if (store !== undefined) {
    options.store = store;
  }
  const stats = await branchStats(options);
  const cValue = oneOption(parsed, "c");
  const c = cValue === undefined ? 1.4 : Number(cValue);
  if (!Number.isFinite(c) || c < 0) {
    throw new DalError("USAGE_ERROR", "Option --c must be a non-negative number");
  }
  const result = selectBranchUcb(stats, c);
  printJson(io, {
    selected: result.selected,
    reason: result.reason,
    stats: result.stats,
  });
}

async function verifyRunCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["action", "command", "workspace", "runner"]);
  exactlyPositionals(parsed, 0, "verify run --action <action-file> --command <command-line> [--workspace <dir>] [--runner local|docker]");
  const options: Parameters<typeof runVerifier>[0] = {
    actionPath: requiredOption(parsed, "action"),
    commandLine: requiredOption(parsed, "command"),
    workspaceRoot: oneOption(parsed, "workspace") ?? process.cwd(),
  };
  const runner = runnerValue(oneOption(parsed, "runner"));
  if (runner === "docker") {
    const policy = await loadPolicy();
    options.runner = "docker";
    options.docker = {
      image: policy.docker_image ?? "dsh-adaptive-loop/dsh:0.1.1-rc.2",
      runFlags: policy.docker_run_flags ?? [],
      envNames: policy.docker_env_names ?? [],
    };
  }
  const result = await runVerifier(options);
  printJson(io, {
    status: result.passed ? "passed" : "failed",
    exit_code: result.exit_code,
    sandbox: result.sandbox,
  });
  if (result.stderr !== "") {
    io.stderr(result.stderr);
  }
  if (!result.passed) {
    throw new DalError("VERIFIER_FAILED", `Verifier exited ${result.exit_code}`);
  }
}

async function improvementTransition(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["to", "actor-kind", "actor-id", "at", "evidence", "notes", "decision", "output"]);
  const [filePath] = exactlyPositionals(parsed, 1, "improvement transition <proposal-file> [options]");
  const requestedOutput = requiredOption(parsed, "output");
  const evidence = manyOptions(parsed, "evidence");
  if (evidence.length === 0) {
    throw new DalError("USAGE_ERROR", "At least one --evidence URI is required");
  }
  const proposal = await readProposalFile(filePath!);
  const decisionPath = oneOption(parsed, "decision");
  let decision: ApprovalDecision | undefined;
  if (decisionPath !== undefined) {
    const document = await readJsonFile<unknown>(decisionPath);
    assertNoSecrets(scanSecrets(document.value, document.raw.toString("utf8")));
    assertNoPii(scanPii(document.value, document.raw.toString("utf8")));
    decision = await validateApprovalDecision(document.value);
  }

  const options: Parameters<typeof transitionProposal>[1] = {
    to: proposalStage(requiredOption(parsed, "to")),
    actor: {
      kind: actorKind(requiredOption(parsed, "actor-kind")),
      id: requiredOption(parsed, "actor-id"),
    },
    evidence,
    notes: requiredOption(parsed, "notes"),
  };
  const at = oneOption(parsed, "at");
  if (at !== undefined) {
    options.at = parseDate(at, "at");
  }
  if (decision !== undefined) {
    options.decision = decision;
  }
  const transitioned = await transitionProposal(proposal, options);
  const policy = await loadPolicy();
  const { destination: output, root } = resolveDedicatedRepositoryWritePath(
    requestedOutput,
    policy.proposal_write_root,
  );
  await prepareSafeRepositoryDirectory(root);
  await assertNoSymlinkTraversal(output);
  if (!(await publishJsonExclusive(output, transitioned))) {
    throw new DalError("PROPOSAL_OUTPUT_CONFLICT", `Proposal output already exists: ${displayPath(output)}`);
  }
  printJson(io, {
    status: "recorded",
    proposal_id: transitioned.proposal_id,
    stage: transitioned.stage,
    output: displayPath(resolve(process.cwd(), output)),
  });
}

async function resetStatusCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["workspace"]);
  exactlyPositionals(parsed, 0, "reset status [--workspace <directory>]");
  const workspaceDir = oneOption(parsed, "workspace");
  printJson(io, await resetStatus(workspaceDir === undefined ? {} : { workspaceDir }));
}

async function resetExecuteCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["workspace", "reason", "actor", "acknowledge"]);
  exactlyPositionals(
    parsed,
    0,
    "reset execute [--workspace <directory>] --reason <text> [--actor <id>] --acknowledge remove-all-evidence",
  );
  const options: Parameters<typeof resetExecute>[0] = {
    reason: requiredOption(parsed, "reason"),
  };
  const acknowledge = oneOption(parsed, "acknowledge");
  if (acknowledge !== undefined) {
    options.acknowledge = acknowledge;
  }
  const workspaceDir = oneOption(parsed, "workspace");
  if (workspaceDir !== undefined) {
    options.workspaceDir = workspaceDir;
  }
  const actor = oneOption(parsed, "actor");
  if (actor !== undefined) {
    options.actor = actor;
  }
  printJson(io, await resetExecute(options));
}

async function optimizePrepareCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["skill", "store"]);
  exactlyPositionals(parsed, 0, "optimize prepare --skill <path> [--store <directory>]");
  const prepared = await prepareOptimizerExchange({
    skillPath: requiredOption(parsed, "skill"),
    store: oneOption(parsed, "store") ?? ".dal/runs",
  });
  const exchangePath = resolve(process.cwd(), prepared.exchangePath);
  await writeJsonAtomic(exchangePath, prepared.exchange);
  printJson(io, {
    status: "prepared",
    exchange_id: prepared.exchange.exchange_id,
    exchange_path: displayPath(exchangePath),
    training_set_id: prepared.trainingSet.training_set_id,
    training_set_path: prepared.trainingSetPath,
    episodes: prepared.trainingSet.episodes.length,
    target: prepared.exchange.target,
  });
}

async function optimizeEvaluateCommand(argv: readonly string[], io: CliIo): Promise<void> {
  const parsed = parseArguments(argv);
  assertOptions(parsed, ["exchange", "candidate", "output", "candidate-out"]);
  exactlyPositionals(
    parsed,
    0,
    "optimize evaluate --exchange <file> --candidate <file> --output <verdict-file> [--candidate-out <path>]",
  );
  const result = await evaluateOptimizerCandidate({
    exchangePath: requiredOption(parsed, "exchange"),
    candidatePath: requiredOption(parsed, "candidate"),
  });
  const output = resolve(process.cwd(), requiredOption(parsed, "output"));
  await publishJsonExclusive(output, result.verdict);
  const candidateOut = oneOption(parsed, "candidate-out");
  if (candidateOut !== undefined && result.candidateText !== null) {
    const target = resolve(process.cwd(), candidateOut);
    await writeJsonAtomic(target, result.candidateText);
  }
  printJson(io, {
    status: result.verdict.verdict,
    verdict_id: result.verdict.verdict_id,
    candidate_sha256: result.verdict.candidate_sha256,
    checks: result.verdict.checks,
  });
  if (result.verdict.verdict !== "valid") {
    throw new DalError("OPTIMIZE_CANDIDATE_REJECTED", "The candidate failed the deterministic validation gate");
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], options: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      parsed.positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    let value: string;
    if (equals !== -1) {
      value = argument.slice(equals + 1);
    } else {
      const following = argv[index + 1];
      if (following === undefined || following.startsWith("--")) {
        throw new DalError("USAGE_ERROR", `Option --${name} requires a value`);
      }
      value = following;
      index += 1;
    }
    const values = parsed.options.get(name) ?? [];
    values.push(value);
    parsed.options.set(name, values);
  }
  return parsed;
}

function assertOptions(parsed: ParsedArguments, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) {
      throw new DalError("USAGE_ERROR", `Unknown option --${name}`);
    }
  }
}

function exactlyPositionals(parsed: ParsedArguments, count: number, usage: string): string[] {
  if (parsed.positionals.length !== count) {
    throw new DalError("USAGE_ERROR", `Usage: dal ${usage}`);
  }
  return parsed.positionals;
}

function oneOption(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.options.get(name);
  if (values !== undefined && values.length > 1) {
    throw new DalError("USAGE_ERROR", `Option --${name} may be supplied only once`);
  }
  return values?.[0];
}

function manyOptions(parsed: ParsedArguments, name: string): string[] {
  return [...(parsed.options.get(name) ?? [])];
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = oneOption(parsed, name);
  if (value === undefined || value === "") {
    throw new DalError("USAGE_ERROR", `Missing required option --${name}`);
  }
  return value;
}

function queryFrom(parsed: ParsedArguments): FeedbackQuery {
  const query: FeedbackQuery = {};
  const feedbackId = oneOption(parsed, "feedback");
  const changeId = oneOption(parsed, "change");
  const outcome = oneOption(parsed, "outcome");
  const privacyTag = oneOption(parsed, "privacy-tag");
  const from = oneOption(parsed, "from");
  const to = oneOption(parsed, "to");
  if (feedbackId !== undefined) query.feedbackId = feedbackId;
  if (changeId !== undefined) query.changeId = changeId;
  if (outcome !== undefined) query.outcome = feedbackOutcome(outcome);
  if (privacyTag !== undefined) query.privacyTag = privacyTag;
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  return query;
}

function outputFormat(parsed: ParsedArguments): "json" | "text" {
  const format = oneOption(parsed, "format") ?? "text";
  if (format !== "json" && format !== "text") {
    throw new DalError("USAGE_ERROR", `Unsupported format: ${format}`);
  }
  return format;
}

function feedbackOutcome(value: string): FeedbackOutcome {
  if (value !== "completed" && value !== "blocked" && value !== "aborted") {
    throw new DalError("USAGE_ERROR", `Unsupported feedback outcome: ${value}`);
  }
  return value;
}

function sensitiveAction(value: string): SensitiveAction {
  if (!(SENSITIVE_ACTIONS as readonly string[]).includes(value)) {
    throw new DalError("USAGE_ERROR", `Unsupported sensitive action: ${value}`);
  }
  return value as SensitiveAction;
}

function proposalStage(value: string): ProposalStage {
  if (!(PROPOSAL_STAGES as readonly string[]).includes(value)) {
    throw new DalError("USAGE_ERROR", `Unsupported proposal stage: ${value}`);
  }
  return value as ProposalStage;
}

function runnerValue(value: string | undefined): "local" | "docker" {
  if (value === undefined || value === "local") {
    return "local";
  }
  if (value === "docker") {
    return "docker";
  }
  throw new DalError("USAGE_ERROR", `Unsupported runner: ${value}`);
}

function actorKind(value: string): ActorKind {
  if (value !== "human" && value !== "dsh-agent" && value !== "automation" && value !== "import") {
    throw new DalError("USAGE_ERROR", `Unsupported actor kind: ${value}`);
  }
  return value;
}

function parseDate(value: string, option: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DalError("USAGE_ERROR", `Invalid --${option} date: ${value}`);
  }
  return date;
}

function displayPath(filePath: string): string {
  const absolute = resolve(process.cwd(), filePath);
  const local = relative(process.cwd(), absolute);
  return local !== "" && !local.startsWith("..") ? local : filePath;
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `DSH Adaptive Loop (dal)\n\nUsage:\n  dal feedback validate <file>\n  dal feedback ingest <file> [--store <directory>]\n  dal feedback query [--feedback <id>] [--change <id>] [--outcome <status>]\n                     [--privacy-tag <tag>] [--from <date>] [--to <date>]\n                     [--store <directory>] [--format text|json]\n  dal feedback summary [query filters] [--format text|json]\n  dal capsule check <path-or-directory>\n  dal approval verify <decision-file> --action <action> --scope <scope>\n                      [--candidate-sha256 <digest>] [--at <date-time>]\n  dal policy check <action-file> [--approval <decision-file>] [--store <directory>]\n  dal eval run <suite-file> [--store <directory>]\n  dal run ingest <file> [--store <directory>]\n  dal cluster run [--store <directory>] [--output <directory>] [--format text|json]\n  dal init [--dir <directory>] [--skill <name>]\n  dal install user-global --approval <decision-file>\n  dal reset status [--workspace <directory>]\n  dal reset execute [--workspace <directory>] --reason <text> [--actor <id>] --acknowledge remove-all-evidence\n  dal optimize prepare --skill <path> [--store <directory>]\n  dal optimize evaluate --exchange <file> --candidate <file> --output <verdict-file> [--candidate-out <path>]\n  dal seal init --cases <dir> --output <dir> [--holdout <count>]\n  dal seal verify --sealed <dir> --cases <dir>\n  dal seal reveal --sealed <dir> --candidate <id>\n  dal saga begin --intent <id> --action <effect> --payload <file-or-uri>\n  dal saga complete --intent <id> --outcome completed|failed --receipt <file-or-uri>\n  dal saga status --intent <id>\n  dal saga list [--store <directory>]\n  dal admit issue --admission <id> --candidate <file-or-uri>\n  dal admit complete --admission <id> --result <result-file>\n  dal admit status --admission <id>\n  dal propose prepare --clusters <dir> [--runs <dir>] --output <payload-file>\n  dal propose run --clusters <dir> --approval <decision> --workspace <dir> --output <draft-file>\n                     [--provider <p>] [--model <m>] [--runner local|docker]\n  dal branch record --branch <id> --draft <file> [--parent <branch-id>]\n  dal branch evaluate --branch <id> --task <task-file> --state <state-file>\n  dal branch stats [--store <directory>]\n  dal branch select [--store <directory>] [--c <exploration>]\n  dal verify run --action <action-file> --command <command-line> [--workspace <dir>] [--runner local|docker]\n  dal improvement transition <proposal-file> --to <stage>\n                             --actor-kind <kind> --actor-id <id>\n                             --evidence <uri> --notes <text> --output <new-file>\n                             [--decision <file>] [--at <date-time>]\n\nNo command runs an optimizer, invokes an LLM, executes a requested action, sends data, installs a plugin, or changes dsh configuration.\n`;

export function matchesEntryPoint(
  invokedPath: string | undefined,
  entryUrl: string,
  realpath: (value: string) => string = realpathSync,
): boolean {
  if (invokedPath === undefined) {
    return false;
  }
  if (entryUrl === pathToFileURL(invokedPath).href) {
    return true;
  }
  try {
    return realpath(invokedPath) === fileURLToPath(entryUrl);
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && matchesEntryPoint(invokedPath, import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
