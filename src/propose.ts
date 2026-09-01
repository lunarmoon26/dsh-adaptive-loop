import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { validateApprovalDecision, verifyApproval } from "./approval.js";
import { assertDockerAvailable, containerPath, runDocker } from "./docker.js";
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
  harness_contract: { uri: string; sha256: string };
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
  provenance: { runner: "dsh-headless" | "dsh-headless-docker" | "injected"; clusters: Array<{ cluster_id: string; category: string; code: string; member_count: number }> };
}

export type ProposalRunner = (prompt: string) => Promise<string>;

const SUMMARY_CAP = 512;
const MAX_CLUSTERS = 24;

const OUTPUT_CONTRACT = `You are proposing a change to a DeepSeek Harness workspace. Before proposing a harness_code or skills change, read the pinned dsh plugin contract at repo://docs/dsh-plugin-contract.md (digest provided in the payload's harness_contract field) so the proposal respects bundle patches, tool registration, and the editable-surface boundaries. Respond with exactly one JSON object and nothing else. Required keys:
surface (one of the editable surfaces listed), target_uri (a repo:// URI of the artifact you propose to change),
base_sha256 (the current artifact digest), title (short), objective (one sentence),
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
  if (options.runsDir !== undefined) {
    const runsDir = resolve(process.cwd(), options.runsDir);
    for (const name of (await readdir(runsDir).catch(() => [])).filter((name) => name.endsWith(".json"))) {
      try {
        const document = await readJsonFile<unknown>(resolve(runsDir, name));
        const run = document.value as RunRecord;
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
    const representative = runSummaries.get(record.representative.run_id) ?? "No summary recorded for the representative run.";
    clusters.push({
      cluster_id: record.cluster_id,
      category: record.fingerprint.category,
      code: record.fingerprint.code,
      member_count: record.member_count,
      representative_failure: representative,
    });
  }

  const contractText = await readFile(resolve(process.cwd(), "docs", "dsh-plugin-contract.md"), "utf8").catch(() => "");
  const contractDigest = sha256(contractText);
  const payload: ProposePayload = {
    task: "propose_one_falsifiable_change",
    editable_surfaces: EDITABLE_SURFACES,
    clusters,
    harness_contract: {
      uri: "repo://docs/dsh-plugin-contract.md",
      sha256: contractDigest,
    },
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

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new DalError("PROPOSE_REPLY_INVALID", "Proposer reply contains no JSON object");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DalError("PROPOSE_REPLY_INVALID", "Proposer reply JSON does not parse");
  }
}

export async function proposeDraft(options: {
  payload: ProposePayload;
  payloadDigest: string;
  runner: ProposalRunner;
  runnerKind: "dsh-headless" | "dsh-headless-docker" | "injected";
  model: { provider: string; model: string };
}): Promise<ProposalDraft> {
  const reply = await options.runner(prettyJson(options.payload));
  const parsed = extractJsonObject(reply);
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
      clusters: options.payload.clusters.map((cluster) => ({
        cluster_id: cluster.cluster_id,
        category: cluster.category,
        code: cluster.code,
        member_count: cluster.member_count,
      })),
    },
  };
  await assertSchema(SCHEMA_IDS.proposalDraft, draft, "Proposal draft");
  return draft;
}

export function dshHeadlessRunner(options: { workspaceDir: string; modelPatch?: { provider: string; model: string }; timeoutMs?: number }): ProposalRunner {
  return async (prompt) => {
    const args = ["--profile", "headless"];
    let patchPath: string | undefined;
    if (options.modelPatch !== undefined) {
      patchPath = resolve(options.workspaceDir, `.dal-propose-patch-${randomUUID()}.yml`);
      await writeFile(
        patchPath,
        `- id: agent-default-model\n  config:\n    provider: ${options.modelPatch.provider}\n    model: ${options.modelPatch.model}\n`,
        "utf8",
      );
      args.push("--patch", patchPath);
    }
    args.push(prompt);
    const result = spawnSync("dsh", args, {
      cwd: options.workspaceDir,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 300000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (patchPath !== undefined) {
      await import("node:fs/promises").then(({ unlink }) => unlink(patchPath)).catch(() => undefined);
    }
    if (result.error !== undefined) {
      throw new DalError("PROPOSE_RUNNER_FAILED", `dsh headless failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new DalError("PROPOSE_RUNNER_FAILED", `dsh headless exited ${result.status}: ${result.stderr.slice(-500)}`);
    }
    return result.stdout;
  };
}

/**
 * Container-hosted headless runner: the same dsh headless invocation runs
 * inside the pinned container with the workspace mounted at /workspace.
 * Model credentials pass through only the policy-listed environment names.
 */
export function dshHeadlessDockerRunner(options: {
  workspaceDir: string;
  modelPatch?: { provider: string; model: string };
  docker: { image: string; runFlags: string[]; envNames: string[] };
  timeoutMs?: number;
}): ProposalRunner {
  return async (prompt) => {
    assertDockerAvailable();
    const args = ["--profile", "headless"];
    let patchPath: string | undefined;
    if (options.modelPatch !== undefined) {
      patchPath = resolve(options.workspaceDir, `.dal-propose-patch-${randomUUID()}.yml`);
      await writeFile(
        patchPath,
        `- id: agent-default-model\n  config:\n    provider: ${options.modelPatch.provider}\n    model: ${options.modelPatch.model}\n`,
        "utf8",
      );
      args.push("--patch", containerPath(patchPath, options.workspaceDir));
    }
    args.push(prompt);
    const result = runDocker(
      {
        image: options.docker.image,
        runFlags: options.docker.runFlags,
        envNames: options.docker.envNames,
        workspaceRoot: options.workspaceDir,
        network: "default",
      },
      ["dsh", ...args],
      (options.timeoutMs ?? 300000) + 60_000,
    );
    if (patchPath !== undefined) {
      await import("node:fs/promises").then(({ unlink }) => unlink(patchPath)).catch(() => undefined);
    }
    if (result.status !== 0) {
      throw new DalError("PROPOSE_RUNNER_FAILED", `dsh headless in container exited ${result.status}: ${result.stderr.slice(-500)}`);
    }
    return result.stdout;
  };
}

export async function runPropose(options: {
  clustersDir: string;
  runsDir?: string;
  approvalPath: string;
  workspaceDir: string;
  outputPath: string;
  model: { provider: string; model: string };
  runnerOverride?: ProposalRunner;
  runner?: "local" | "docker";
  docker?: { image: string; runFlags: string[]; envNames: string[] };
}): Promise<{ status: "recorded" | "idempotent"; path: string; draft: ProposalDraft; payload_digest: string }> {
  const prepared = await prepareProposePayload({
    clustersDir: options.clustersDir,
    ...(options.runsDir !== undefined ? { runsDir: options.runsDir } : {}),
  });

  const document = await readJsonFile<unknown>(options.approvalPath);
  assertNoSecrets(scanSecrets(document.value, document.raw.toString("utf8")));
  assertNoPii(scanPii(document.value, document.raw.toString("utf8")));
  const decision = await validateApprovalDecision(document.value);
  await verifyApproval(decision, { action: "send_data_externally", scope: prepared.digest, at: new Date() });

  const dockerDefaults = { image: "dsh-adaptive-loop/dsh:0.1.1-rc.2", runFlags: [], envNames: [] };
  const runner =
    options.runnerOverride ??
    (options.runner === "docker"
      ? dshHeadlessDockerRunner({
          workspaceDir: options.workspaceDir,
          modelPatch: options.model,
          docker: options.docker ?? dockerDefaults,
        })
      : dshHeadlessRunner({ workspaceDir: options.workspaceDir, modelPatch: options.model }));
  const runnerKind =
    options.runnerOverride !== undefined ? "injected" : options.runner === "docker" ? "dsh-headless-docker" : "dsh-headless";
  const draft = await proposeDraft({
    payload: prepared.payload,
    payloadDigest: prepared.digest,
    runner,
    runnerKind,
    model: options.model,
  });

  const destination = resolve(process.cwd(), options.outputPath);
  const published = await publishJsonExclusive(destination, draft);
  if (!published) {
    const existing = await readJsonFile<ProposalDraft>(destination);
    if (sha256(canonicalJson(existing.value)) === sha256(canonicalJson(draft))) {
      return { status: "idempotent", path: destination, draft: existing.value, payload_digest: prepared.digest };
    }
    throw new DalError("PROPOSE_OUTPUT_CONFLICT", `Draft output already exists with different content: ${destination}`);
  }
  return { status: "recorded", path: destination, draft, payload_digest: prepared.digest };
}
