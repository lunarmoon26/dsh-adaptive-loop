import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { validateApprovalDecision, verifyApproval } from "./approval.js";
import { prepareChatRequest, sendChatRequest, requestModel, RESPONSE_LIMIT, type ProposalBudget } from "./propose-transport.js";
import { reserveProposalBudget } from "./proposal-budget.js";
import { DalError } from "./errors.js";
import { canonicalJson, prettyJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { ClusterRecord, RunRecord } from "./types.js";
import { EDITABLE_SURFACES, type EditableSurface } from "./types.js";

export interface ProposePayload {
  task: "propose_one_falsifiable_change";
  editable_surfaces: readonly EditableSurface[];
  clusters: Array<{
    cluster_id: string;
    category: string;
    code: string;
    member_count: number;
    representative_failure: string;
  }>;
  output_contract: string;
}

export interface ProposalDraft {
  $schema: string;
  schema_version: "1.0.0";
  draft_id: string;
  created_at: string;
  payload_sha256: string;
  model: { provider: string; model: string };
  surface: EditableSurface;
  target_uri: string;
  base_sha256: string;
  title: string;
  objective: string;
  statement: string;
  improvements: Array<{ metric: string; expected_delta: number }>;
  regressions: Array<{ summary: string; severity: "low" | "medium" | "high" }>;
  provenance: { runner: "deepseek-https" | "openai-https" | "anthropic-https" | "injected"; request_sha256: string; clusters: Array<{ cluster_id: string; category: string; code: string; member_count: number }> };
}

export type ProposalRunner = (prompt: string) => Promise<string>;

const SUMMARY_CAP = 512;
const MAX_CLUSTERS = 24;

const OUTPUT_CONTRACT = `You are proposing a change from sanitized DeepSeek Harness failure summaries only. Do not read files or retrieve references. Respond with exactly one JSON object and nothing else. Required keys:
surface (one of the editable surfaces listed), target_uri (a repo:// URI of the artifact you propose to change),
base_sha256 (an unverified proposed base digest; never claim it was read or verified), title (short), objective (one sentence),
statement (one falsifiable prediction, e.g. "applying this change raises <metric> by at least <delta> on the held-out cases without regressing golden cases"),
improvements (array of {metric, expected_delta} with metric from task_success_rate, test_pass_rate, policy_precision, policy_recall, blocked_dangerous_action_rate, human_override_rate, post_change_regression_rate),
regressions (array of {summary, severity: low|medium|high}, may be empty).
Do not propose changes to the evaluator, sealed holdout, permissions, budget, promotion policy, audit log, or rollback mechanism.`;

export async function prepareProposePayload(options: { clustersDir: string; runsDir?: string }): Promise<{
  payload: ProposePayload;
  digest: string;
  json: string;
}> {
  const clustersDir = resolve(process.cwd(), options.clustersDir);
  let names: string[];
  try {
    names = (await readdir(clustersDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new DalError("PROPOSE_CLUSTERS_MISSING", `Cluster store is not readable: ${clustersDir}`);
  }
  if (names.length === 0) {
    throw new DalError("PROPOSE_NO_CLUSTERS", "No cluster records to propose from");
  }
  const runSummaries = new Map<string, string>();
  const runModes = new Map<string, "eligible" | "rehearsal" | "unavailable">();
  if (options.runsDir !== undefined) {
    const runsDir = resolve(process.cwd(), options.runsDir);
    for (const name of (await readdir(runsDir).catch(() => [])).filter((name) => name.endsWith(".json"))) {
      try {
        const document = await readJsonFile<unknown>(resolve(runsDir, name));
        const run = document.value as RunRecord;
        runModes.set(run.run_id, await proposalEvidenceMode(run));
        const summary = representativeFailure(run);
        if (summary !== null) {
          runSummaries.set(run.run_id, summary);
        }
      } catch {
        // skip unreadable run records; clusters remain the authority
      }
    }
  }

  const clusters: ProposePayload["clusters"] = [];
  for (const name of names.slice(0, MAX_CLUSTERS)) {
    const document = await readJsonFile<ClusterRecord>(resolve(clustersDir, name));
    await assertSchema(SCHEMA_IDS.clusterRecord, document.value, "Cluster record");
    const record = document.value;
    for (const member of record.members) {
      const mode = runModes.get(member.run_id);
      if (mode === "rehearsal") throw new DalError("PROPOSE_REHEARSAL_EVIDENCE", "Rehearsal evidence cannot feed proposal generation");
      if (mode === "unavailable" || (member.run_id.startsWith("run-e2e-") && mode === undefined)) {
        throw new DalError("PROPOSE_EVIDENCE_UNAVAILABLE", "E2E proposal inputs require readable, mode-qualified run evidence via --runs");
      }
    }
    const representative = runSummaries.get(record.representative.run_id) ?? "No summary recorded for the representative run.";
    clusters.push({
      cluster_id: record.cluster_id,
      category: record.fingerprint.category,
      code: record.fingerprint.code,
      member_count: record.member_count,
      representative_failure: representative,
    });
  }

  const payload: ProposePayload = {
    task: "propose_one_falsifiable_change",
    editable_surfaces: EDITABLE_SURFACES,
    clusters,
    output_contract: OUTPUT_CONTRACT,
  };
  const json = prettyJson(payload);
  assertNoSecrets(scanSecrets(payload, json));
  assertNoPii(scanPii(payload, json));
  return { payload, digest: sha256(json), json };
}

function representativeFailure(run: RunRecord): string | null {
  if (run.failure?.summary !== undefined) {
    return run.failure.summary.slice(0, SUMMARY_CAP);
  }
  if (run.outcome !== "succeeded" || run.business_outcome?.status !== "failed") {
    return null;
  }
  const details = (run.checks ?? [])
    .filter((check) => !check.pass)
    .map((check) => check.detail?.trim() ?? "")
    .filter((detail) => detail !== "");
  return (details.length === 0 ? "Business outcome failed deterministic checks." : details.join("; ")).slice(0, SUMMARY_CAP);
}

async function proposalEvidenceMode(run: RunRecord): Promise<"eligible" | "rehearsal" | "unavailable"> {
  if (!Array.isArray(run.evidence)) return "unavailable";
  if (run.evidence.some(uri => uri === "dal-e2e-mode://rehearsal" || /^repo:\/\/\.dal\/check\/e2e-gateways\/run-[a-z0-9._-]+\/rehearsal\.json$/.test(uri))) return "rehearsal";
  const receipts = run.evidence.filter(uri => /^repo:\/\/\.dal\/check\/e2e-gateways\/run-[a-z0-9._-]+\/receipt\.json$/.test(uri));
  for (const uri of receipts) {
    try {
      const receipt = await readJsonFile<{ mode?: unknown; run_id?: unknown }>(resolve(process.cwd(), uri.slice("repo://".length)));
      if (receipt.value.run_id !== run.run_id) return "unavailable";
      if (receipt.value.mode === "rehearsal") return "rehearsal";
      if (receipt.value.mode !== "live") return "unavailable";
    } catch { return "unavailable"; }
  }
  return "eligible";
}

function extractJsonObject(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new DalError("PROPOSE_REPLY_INVALID", "Proposer reply JSON does not parse");
  }
}

export async function proposeDraft(options: {
  payload: ProposePayload;
  payloadDigest: string;
  requestDigest: string;
  runner: ProposalRunner;
  runnerKind: ProposalDraft["provenance"]["runner"];
  model: { provider: string; model: string };
}): Promise<ProposalDraft> {
  const reply = await options.runner(prettyJson(options.payload));
  if (Buffer.byteLength(reply) > RESPONSE_LIMIT) throw new DalError("PROPOSE_RESPONSE_TOO_LARGE", "Proposer reply exceeds the byte limit");
  const parsed = extractJsonObject(reply);
  // Scan the whole reply, including fields not projected into the persisted draft.
  if (scanSecrets(parsed, reply).length) throw new DalError("SECRET_DETECTED", "Proposer reply contains sensitive material");
  if (scanPii(parsed, reply).length) throw new DalError("PII_DETECTED", "Proposer reply contains sensitive material");
  const value = parsed as {
    surface?: unknown;
    target_uri?: unknown;
    base_sha256?: unknown;
    title?: unknown;
    objective?: unknown;
    statement?: unknown;
    improvements?: unknown;
    regressions?: unknown;
  };
  if (!EDITABLE_SURFACES.includes(value.surface as EditableSurface)) {
    throw new DalError("PROPOSE_REPLY_INVALID", "Proposer returned an ineditable or unknown surface");
  }
  const draft: ProposalDraft = {
    $schema: SCHEMA_IDS.proposalDraft,
    schema_version: "1.0.0",
    draft_id: `drf-${randomUUID()}`,
    created_at: new Date().toISOString(),
    payload_sha256: options.payloadDigest,
    model: options.model,
    surface: value.surface as EditableSurface,
    target_uri: value.target_uri as string,
    base_sha256: value.base_sha256 as string,
    title: value.title as string,
    objective: value.objective as string,
    statement: value.statement as string,
    improvements: (value.improvements ?? []) as ProposalDraft["improvements"],
    regressions: (value.regressions ?? []) as ProposalDraft["regressions"],
    provenance: {
      runner: options.runnerKind,
      request_sha256: options.requestDigest,
      clusters: options.payload.clusters.map((cluster) => ({
        cluster_id: cluster.cluster_id,
        category: cluster.category,
        code: cluster.code,
        member_count: cluster.member_count,
      })),
    },
  };
  assertNoSecrets(scanSecrets(draft));
  assertNoPii(scanPii(draft));
  await assertSchema(SCHEMA_IDS.proposalDraft, draft, "Proposal draft");
  return draft;
}

export async function prepareProposeRequest(options: {
  clustersDir: string;
  runsDir?: string;
  model: { provider: string; model: string };
  budget: ProposalBudget;
}) {
  const prepared = await prepareProposePayload(options);
  const chat = prepareChatRequest(prepared.payload, options.model, options.budget);
  await assertSchema(chat.request.$schema, chat.request, "Proposer request");
  return { ...prepared, ...chat };
}

export async function runPropose(options: {
  clustersDir: string;
  runsDir?: string;
  approvalPath: string;
  workspaceDir?: string;
  outputPath: string;
  model: { provider: string; model: string };
  budget: ProposalBudget;
  /** Evaluator-owned store; CLI always uses .dal/proposal-budgets. */
  budgetStore?: string;
  /** Internal offline test seam. Never expose through CLI or configuration. */
  runnerOverride?: ProposalRunner;
  runner?: "local" | "docker";
  docker?: { image: string; runFlags: string[]; envNames: string[] };
}): Promise<{ status: "recorded" | "idempotent"; path: string; draft: ProposalDraft; payload_digest: string; request_digest: string; budget_reservation: { reserved_microusd: number; remaining_microusd: number } }> {
  if ((options.runner !== undefined && options.runner !== "local") || options.docker !== undefined) {
    throw new DalError("PROPOSE_RUNNER_UNSUPPORTED", "Docker proposer execution is disabled; use an approved payload-only HTTPS request");
  }
  const prepared = await prepareProposeRequest({
    clustersDir: options.clustersDir,
    model: options.model,
    budget: options.budget,
    ...(options.runsDir !== undefined ? { runsDir: options.runsDir } : {}),
  });

  const document = await readJsonFile<unknown>(options.approvalPath);
  assertNoSecrets(scanSecrets(document.value, document.raw.toString("utf8")));
  assertNoPii(scanPii(document.value, document.raw.toString("utf8")));
  const decision = await validateApprovalDecision(document.value);
  await verifyApproval(decision, { action: "send_data_externally", scope: prepared.requestDigest, at: new Date() });

  const destination = resolve(process.cwd(), options.outputPath);
  try {
    await lstat(destination);
    throw new DalError("PROPOSE_OUTPUT_CONFLICT", "Draft output already exists; no request was sent");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const reservation = await reserveProposalBudget({
    store: options.budgetStore ?? resolve(process.cwd(), ".dal/proposal-budgets"),
    budget: prepared.request.budget,
    provider: prepared.request.provider,
    requestDigest: prepared.requestDigest,
    approvalId: decision.decision_id,
  });
  const budgetReservation = { reserved_microusd: reservation.reserved_microusd, remaining_microusd: reservation.remaining_microusd };

  const runner = options.runnerOverride ?? (() => sendChatRequest(prepared.request));
  const runnerKind = options.runnerOverride !== undefined ? "injected"
    : prepared.request.provider === "openai" ? "openai-https"
    : prepared.request.provider === "anthropic" ? "anthropic-https" : "deepseek-https";
  const draft = await proposeDraft({
    payload: prepared.payload,
    payloadDigest: prepared.digest,
    requestDigest: prepared.requestDigest,
    runner,
    runnerKind,
    model: requestModel(prepared.request),
  });

  const published = await publishJsonExclusive(destination, draft);
  if (!published) {
    const existing = await readJsonFile<ProposalDraft>(destination);
    if (sha256(canonicalJson(existing.value)) === sha256(canonicalJson(draft))) {
      return { status: "idempotent", path: destination, draft: existing.value, payload_digest: prepared.digest, request_digest: prepared.requestDigest, budget_reservation: budgetReservation };
    }
    throw new DalError("PROPOSE_OUTPUT_CONFLICT", `Draft output already exists with different content: ${destination}`);
  }
  return { status: "recorded", path: destination, draft, payload_digest: prepared.digest, request_digest: prepared.requestDigest, budget_reservation: budgetReservation };
}
