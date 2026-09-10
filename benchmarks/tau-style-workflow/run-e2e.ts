import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, lstat, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { verifyApprovalFile } from "../../src/approval.js";
import { GATEWAY_ROUTES, validateSpendPolicy, validateGatewayFailure, type GatewayFailure, type E2eSpendPolicy } from "../../src/e2e-model-gateway.js";
import { OPENAI_TEXT_REPLAY_PROFILE } from "../../src/e2e-openai-text-replay.js";
import { canonicalJson, sha256 } from "../../src/json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "../../src/privacy.js";
import { ingestRunRecord } from "../../src/runs.js";
import { buildGatewayCompositionPatch, promptFor } from "./e2e-prompt.js";
import { compareGate, readSummary, type E2eSummary, type TaskSummary } from "./e2e-summary.js";
import {
  candidateDockerArgv,
  containerIsolationFacts,
  type ContainerInspection,
  gatewayDockerArgv,
  networkDockerArgv,
  graderDockerArgv,
  SERVICE_ALIAS,
  SERVICE_URL,
  serviceDockerArgv,
  stageCandidateWorkspace,
  topologyFor,
  type DockerTopology,
} from "./e2e-topology.js";
import {
  initializeService,
  projectServiceState,
  type EffectKind,
  type EffectOutcome,
  type ServiceState,
} from "./.dsh/plugins/dal-workflow-tools/src/service.js";
import {
  agentVisibleTask,
  gradeTask,
  GRADER_VERSION,
  stableJson,
  type Verdict,
  type WorkflowEffectObservation,
  type WorkflowTask,
} from "../../src/workflow-grader.js";

/**
 * Approval-bound e2e driver for the tau-style benchmark workspace.
 *
 * Every run batch is a set of model calls: the batch manifest (model, runner,
 * task prompts) is hashed and the driver verifies an exact approved,
 * unexpired send_data_externally decision against that digest before the
 * first call. Tasks run through `dsh --profile headless` in the pinned
 * candidate container; state/effects are owned by a separate service and
 * graded in a third container. One immutable run record per task is ingested.
 * The driver performs no optimization and applies nothing.
 */

const workspace = resolve(import.meta.dirname);
const repoRoot = resolve(workspace, "..", "..");
const DEFAULT_IMAGE = "dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2";
const POLICY_PATH = join(workspace, "tasks", "policy.md");
const SKILL_PATH = join(workspace, ".agents", "skills", "refund-workflow", "SKILL.md");

/** Select only a bounded, real repository-local Markdown artifact, never a live-file mutation. */
export async function selectedSkillArtifact(args: Map<string, string>) {
  const path = resolve(repoRoot, args.get("skill") ?? SKILL_PATH);
  const rel = relative(repoRoot, path);
  if (!rel || rel.startsWith("../") || rel === ".." || !path.endsWith(".md")) throw new Error("Skill must be repository-local Markdown");
  if (await realpath(path) !== path) throw new Error("Skill path must not traverse symlinks");
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error("Skill must be a bounded regular file");
  const bytes = await readFile(path);
  if (bytes.byteLength > 65536) throw new Error("Skill exceeds the byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoSecrets(scanSecrets({ skill: text }, text));
  assertNoPii(scanPii({ skill: text }, text));
  return { path, uri: `repo://${rel.split("\\").join("/")}`, sha256: sha256(bytes), size_bytes: bytes.byteLength };
}

export function executionMode(args: Map<string, string>): "rehearsal" | "live" {
  const mode = args.get("mode");
  if (mode !== "rehearsal" && mode !== "live") throw new Error("--mode rehearsal|live is required");
  return mode;
}

/** Stable policy identity is approved before ephemeral capabilities are generated. */
export function gatewayPolicyTemplate(args: Map<string, string>, runId: string): E2eSpendPolicy {
  const mode = executionMode(args);
  const campaign = args.get("campaign");
  const rawCap = args.get("provider-cap-microusd") ?? "";
  if (!/^\d+$/.test(rawCap) || !Number.isSafeInteger(Number(rawCap)) || Number(rawCap) < 1) throw new Error("--provider-cap-microusd must be an explicit positive safe integer");
  if (!campaign || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(campaign)) throw new Error("--campaign must be a safe identifier of at most 80 characters");
  const provider = args.get("provider");
  const policy = {
    schema_version: "1.0.0", campaign_id: campaign,
    budget_id: mode === "rehearsal" ? `rehearsal-${campaign}` : campaign,
    approval_id: args.get("approval-id") ?? (mode === "rehearsal" ? "dec-rehearsal" : ""),
    run_id: runId, provider, model: args.get("model"),
    provider_limit_microusd: Number(rawCap), max_request_bytes: 65536, max_response_bytes: 2097152,
    timeout_ms: 120000, max_output_tokens: 1024,
    pricing_profile: "reviewed-text-upper-rates-20260907-v1", token_bound_profile: "json-bytes-times-two-plus-8192-v1",
    input_microusd_per_token: provider === "openai" ? 5 : 4,
    output_microusd_per_token: provider === "openai" ? 18 : 10,
  };
  validateSpendPolicy(policy);
  return policy;
}

export async function gatewayLedgerRoot(args: Map<string, string>): Promise<string> {
  const root = await realpath(repoRoot);
  const path = join(root, ".dal", "check", "spend");
  if (args.has("gateway-ledger") && args.get("gateway-ledger") !== path) throw new Error("--gateway-ledger overrides are disabled; use the canonical repository .dal/check/spend root");
  await assertRealDirectoryAncestors(path);
  return path;
}

/** Rehearsal records cannot enter the ordinary proposal/cluster input store. */
export async function e2eRunStore(args: Map<string, string>): Promise<string> {
  const root = await realpath(repoRoot);
  if (executionMode(args) === "live") return args.get("store") ?? join(root, ".dal", "runs");
  if (args.has("store")) throw new Error("--store is disabled in rehearsal; records are isolated under .dal/check/rehearsal-runs");
  const campaign = args.get("campaign");
  if (!campaign || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(campaign)) throw new Error("--campaign requires a safe identifier");
  const path = join(root, ".dal", "check", "rehearsal-runs", campaign);
  await assertRealDirectoryAncestors(path);
  return path;
}

async function assertRealDirectoryAncestors(path: string): Promise<void> {
  // Check without creating paths during prepare; symlink aliases cannot redirect evidence or budget.
  let ancestor = path;
  for (;;) {
    const info = await lstat(ancestor).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info !== null) {
      if (!info.isDirectory() || await realpath(ancestor) !== ancestor) throw new Error("Evidence and ledger ancestors must be real directories");
      break;
    }
    ancestor = dirname(ancestor);
  }
}

export function plannedRunId(args: Map<string, string>, taskId: string, attempt: number): string {
  const batch = args.get("batch");
  if (!batch || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(batch)) throw new Error("--batch requires a unique planned safe identifier");
  return `run-e2e-${sha256(canonicalJson({ campaign: args.get("campaign"), mode: executionMode(args), provider: args.get("provider"), batch, taskId, attempt })).slice(0, 48)}`;
}

export function safeGatewayReceipt(value: unknown, policy: E2eSpendPolicy, mode: "live" | "rehearsal") {
  const receipt = value as Record<string, unknown> | null;
  if (!receipt || receipt.campaign_id !== policy.campaign_id || receipt.run_id !== policy.run_id || receipt.provider !== policy.provider || receipt.mode !== mode || receipt.accounting !== "upper-bound-reservations-no-refund") throw new Error("Gateway receipt identity mismatch");
  const count = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error("Invalid gateway receipt counter"); return Number(v); };
  const counts = receipt.process_counts as Record<string, unknown> | undefined;
  if (!counts) throw new Error("Missing gateway counters");
  const reserved = count(receipt.reserved_microusd);
  if (reserved > policy.provider_limit_microusd) throw new Error("Gateway receipt exceeds campaign cap");
  let diagnostics: { records: GatewayFailure[]; dropped_count: number } | undefined;
  if (receipt.failure_diagnostics !== undefined) {
    const value = receipt.failure_diagnostics as Record<string, unknown> | null;
    if (!value || Object.keys(value).length !== 2 || !Array.isArray(value.records) || value.records.length > 32 || !("dropped_count" in value)) throw new Error("Invalid gateway failure diagnostics");
    const records = value.records.map(record => { validateGatewayFailure(record); return { ...record }; });
    diagnostics = { records, dropped_count: count(value.dropped_count) };
  }
  return { campaign_id: policy.campaign_id, run_id: policy.run_id, provider: policy.provider, mode,
    reservations: count(receipt.reservations), reserved_microusd: reserved,
    process_counts: { completed: count(counts.completed), failed: count(counts.failed), rejected: count(counts.rejected), response_bytes: count(counts.response_bytes) },
    ...(diagnostics === undefined ? {} : { failure_diagnostics: diagnostics }),
    accounting: "upper-bound-reservations-no-refund" };
}

interface RunTask {
  task_id: string;
  prompt: string;
}

type FaultProfile = Partial<Record<EffectKind, EffectOutcome>>;
type ResolutionProfile = Partial<Record<EffectKind, Exclude<EffectOutcome, "unknown">>>;

export interface TransmissionManifest extends Record<string, unknown> {
  container_image_sha256: string | null;
  benchmark_context_sha256: string;
  generation: "g0" | "g1" | null;
  skill_sha256: string;
  skill_source_uri?: string;
  workflow_tools_sha256: string;
  evaluator_tasks: Array<{ task_id: string; sha256: string }>;
}

function faultProfile(args: Map<string, string>): FaultProfile {
  const profile: FaultProfile = {};
  const raw = args.get("faults");
  if (raw === undefined) return profile;
  for (const pair of raw.split(",")) {
    const [kind, outcome] = pair.split("=");
    if (
      kind !== undefined &&
      ["issue_refund", "create_return_label", "change_booking", "refuse_request"].includes(kind) &&
      (outcome === "success" || outcome === "definite_failure" || outcome === "unknown")
    ) {
      profile[kind as EffectKind] = outcome;
    }
  }
  return profile;
}

function resolutionProfile(args: Map<string, string>): ResolutionProfile {
  const profile: ResolutionProfile = {};
  const raw = args.get("resolutions");
  if (raw === undefined) return profile;
  for (const pair of raw.split(",")) {
    const [kind, outcome] = pair.split("=");
    if (
      kind !== undefined &&
      ["issue_refund", "create_return_label", "change_booking", "refuse_request"].includes(kind) &&
      (outcome === "success" || outcome === "definite_failure")
    ) {
      profile[kind as EffectKind] = outcome;
    }
  }
  return profile;
}

export function renderedCompositionPatch(args: Map<string, string>): string {
  return buildGatewayCompositionPatch(
    args.get("provider") ?? "",
    args.get("model") ?? "",
    SERVICE_URL,
  );
}

function argumentsFrom(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${argument} requires a value`);
    }
    parsed.set(argument.slice(2), value);
    index += 1;
  }
  return parsed;
}


/** Content digest of the pinned harness image (docker runner only). */
async function containerImageDigest(image: string): Promise<string | null> {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    return null;
  }
  const raw = result.stdout.trim().split("\n").at(-1) ?? "";
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(raw);
  return match?.[1] ?? null;
}

/** Canonical digest of a directory tree (sorted file paths, raw contents). */
async function dirDigest(root: string): Promise<string> {
  const files: { path: string; sha256: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      files.push({ path: relative(root, path), sha256: sha256(await readFile(path, "utf8")) });
    }
  };
  await walk(root);
  return sha256(canonicalJson(files));
}

/** Digest of a directory INSIDE the pinned image (the executed bytes). */
async function containerDirDigest(image: string, containerDir: string): Promise<string | null> {
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", image, "sh", "-c", `cd ${containerDir} && find . -type f | sort | xargs sha256sum | sha256sum`],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    return null;
  }
  const match = /^([0-9a-f]{64})\s/.exec(result.stdout.trim());
  return match?.[1] ?? null;
}

/**
 * The transmission manifest the approval decision binds: every model-visible
 * or request-shaping fact — provider, model, runner, faults, container image,
 * agent-visible task content, policy, skill, workflow-tools plugin source,
 * and the exact prompts. A change to any of them changes the digest and
 * therefore requires a fresh approved decision.
 */
export async function transmissionManifest(
  args: Map<string, string>,
  pinnedImageDigest?: string,
): Promise<TransmissionManifest> {
  const tasks = await taskIds(args);
  const runner = args.get("runner") ?? "docker";
  if (runner !== "docker") {
    throw new Error("The integrity benchmark supports only --runner docker");
  }
  const provider = args.get("provider") ?? "deepseek-official";
  const model = args.get("model") ?? "deepseek-v4-flash";
  const selectedGeneration = generationLabel(args);
  const loadedTasks = await Promise.all(tasks.map(async (taskId) => ({
    taskId,
    task: JSON.parse(await readFile(join(workspace, "tasks", taskId), "utf8")) as WorkflowTask,
  })));
  const agentTasks: { task_id: string; sha256: string }[] = [];
  const evaluatorTasks: { task_id: string; sha256: string }[] = [];
  for (const { taskId, task } of loadedTasks) {
    agentTasks.push({ task_id: taskId, sha256: sha256(stableJson(agentVisibleTask(task))) });
    evaluatorTasks.push({ task_id: taskId, sha256: sha256(stableJson(task)) });
  }
  const mode = executionMode(args);
  const policies = tasks.flatMap(taskId => Array.from({ length: attemptCount(args) }, (_, index) => ({
    task_id: taskId, attempt: index + 1, policy: gatewayPolicyTemplate(args, plannedRunId(args, taskId, index + 1)),
  })));
  const ledgerRoot = await gatewayLedgerRoot(args);
  const runStore = await e2eRunStore(args);
  const image = args.get("image") ?? process.env.DAL_E2E_IMAGE ?? DEFAULT_IMAGE;
  const imageDigest = pinnedImageDigest ?? await containerImageDigest(image);
  if (imageDigest === null || !/^[a-f0-9]{64}$/.test(imageDigest)) throw new Error("Pinned Docker image unavailable");
  const imageReference = `sha256:${imageDigest}`;
  const policyDigest = sha256(await readFile(POLICY_PATH, "utf8"));
  const skill = await selectedSkillArtifact(args);
  const skillDigest = skill.sha256;
  const workflowToolsDigest = await containerDirDigest(imageReference, "/opt/dal/plugins/dal-workflow-tools");
  if (workflowToolsDigest === null) {
    throw new Error(`Unable to inspect workflow tools in ${imageReference}; refusing an incomplete transmission manifest`);
  }
  const { verifyImageBuildProvenance } = await import("../../src/e2e-build-provenance.js");
  const buildProvenance = await verifyImageBuildProvenance(repoRoot, imageReference);
  const gatewayImageDigest = buildProvenance.files["dist/e2e-model-gateway.js"];
  if (!gatewayImageDigest) throw new Error("Image is missing the compiled spend gateway; build the derived image before prepare");
  const prompts = tasks.map((taskId) => ({ task_id: taskId, prompt: promptFor(taskId) }));
  const driverSources = {
    openai_text_replay_profile: OPENAI_TEXT_REPLAY_PROFILE,
    gateway_sha256: sha256(await readFile(join(repoRoot, "src/e2e-model-gateway.ts"), "utf8")),
    gateway_schema_sha256: sha256(await readFile(join(repoRoot, "schemas/e2e-spend-policy.v1.schema.json"), "utf8")),
    ledger_sha256: sha256(await readFile(join(repoRoot, "src/proposal-budget.ts"), "utf8")),
    executed_gateway_sha256: gatewayImageDigest,
    build_provenance: buildProvenance,
    run_e2e_sha256: sha256(await readFile(join(workspace, "run-e2e.ts"), "utf8")),
    prompt_sha256: sha256(await readFile(join(workspace, "e2e-prompt.ts"), "utf8")),
    summary_sha256: sha256(await readFile(join(workspace, "e2e-summary.ts"), "utf8")),
    topology_sha256: sha256(await readFile(join(workspace, "e2e-topology.ts"), "utf8")),
  };
  const benchmarkContext = {
    mode,
    gateway_limits: { request_bytes: 65536, output_tokens: 1024, context_window: 139000 },
    runner,
    fault_profile: faultProfile(args),
    resolution_profile: resolutionProfile(args),
    attempts_per_task: attemptCount(args),
    container_image_sha256: imageDigest,
    policy_sha256: policyDigest,
    workflow_tools_sha256: workflowToolsDigest,
    grader_version: GRADER_VERSION,
    agent_tasks: agentTasks,
    evaluator_tasks: evaluatorTasks,
    prompts,
    driver_sources: driverSources,
  };
  const manifest: TransmissionManifest = {
    mode,
    campaign_id: args.get("campaign"),
    gateway_ledger_root: ledgerRoot,
    run_store: runStore,
    gateway_routes: GATEWAY_ROUTES,
    gateway_policies: policies,
    network_policy: { candidate: "internal-only", service: "internal-only", grader: "internal-only", gateway_outbound: mode === "live", host_network: false, docker_socket: false },
    purpose: "tau-style-workflow e2e run batch",
    provider,
    model,
    generation: selectedGeneration,
    runner,
    faults: args.get("faults") ?? null,
    resolutions: args.get("resolutions") ?? null,
    attempts_per_task: attemptCount(args),
    container_image_sha256: imageDigest,
    policy_sha256: policyDigest,
    skill_sha256: skillDigest,
    skill_source_uri: skill.uri,
    skill_size_bytes: skill.size_bytes,
    workflow_tools_sha256: workflowToolsDigest,
    agent_tasks: agentTasks,
    evaluator_tasks: evaluatorTasks,
    prompts,
    rendered_composition_patch: renderedCompositionPatch(args),
    driver_sources: driverSources,
    benchmark_context_sha256: sha256(canonicalJson(benchmarkContext)),
  };
  return manifest;
}

export async function manifestDigest(args: Map<string, string>): Promise<string> {
  const manifest = await transmissionManifest(args);
  requireManifestImageDigest(manifest);
  return sha256(canonicalJson(manifest));
}

function requireManifestImageDigest(manifest: TransmissionManifest): string {
  if (manifest.container_image_sha256 === null) {
    throw new Error(`Docker image ${DEFAULT_IMAGE} is unavailable; refusing to approve or execute an unpinned batch`);
  }
  return manifest.container_image_sha256;
}

function attemptCount(args: Map<string, string>): number {
  const raw = args.get("attempts");
  const count = raw === undefined ? 1 : Number(raw);
  if (!Number.isSafeInteger(count) || count < 1 || (raw !== undefined && !/^\d+$/.test(raw))) {
    throw new Error("--attempts must be a positive integer");
  }
  return count;
}

function generationLabel(args: Map<string, string>): "g0" | "g1" | null {
  const value = args.get("generation");
  if (value === undefined) return null;
  if (value === "g0" || value === "g1") return value;
  if (value === "g2") {
    throw new Error("--generation g2 is disabled: the G2 guard is source-only and has not been mounted or applied");
  }
  throw new Error("--generation must be g0 or g1");
}

async function persistTransmissionManifest(manifest: TransmissionManifest, digest: string): Promise<string> {
  const directory = join(repoRoot, ".dal", "check", "e2e-manifests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.json`);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (sha256(canonicalJson(existing)) !== digest) {
      throw new Error(`Transmission manifest conflict at ${path}`);
    }
  }
  return relative(repoRoot, path);
}

export async function assertTransmissionManifestCurrent(
  args: Map<string, string>,
  approvedImageDigest: string,
  approvedManifestDigest: string,
): Promise<TransmissionManifest> {
  const current = await transmissionManifest(args, approvedImageDigest);
  if (sha256(canonicalJson(current)) !== approvedManifestDigest) {
    throw new Error("Transmission manifest drifted after approval; refusing the model call");
  }
  return current;
}

async function taskIds(args: Map<string, string>): Promise<string[]> {
  const selected = args.get("tasks");
  const files = (await readdir(join(workspace, "tasks"))).filter((name) => name.endsWith(".json")).sort();
  if (selected === undefined) {
    return files;
  }
  const wanted = new Set(selected.split(",").filter((name) => name !== ""));
  const unknown = [...wanted].filter((name) => !files.includes(name));
  if (wanted.size === 0 || unknown.length > 0) {
    throw new Error(`--tasks must name existing benchmark task files${unknown.length === 0 ? "" : `; unknown: ${unknown.join(", ")}`}`);
  }
  return files.filter((name) => wanted.has(name));
}

const SERVICE_ROOT = ".dal/benchmark/service";

/**
 * The dsh session the headless runner persisted into the batch-local home:
 * newest `session.jsonl[.zstd]` under `<home>/sessions/**`. Returns the
 * session id and the raw event-log head digest, or nulls when no session
 * log was written.
 */
async function captureSession(homeRoot: string): Promise<{ sessionId: string | null; eventLogHead: string | null; observation?: ReturnType<typeof sessionObservation> }> {
  const candidates: { mtimeMs: number; path: string }[] = [];
  try {
    const sessionsRoot = join(homeRoot, "sessions");
    for (const project of await readdir(sessionsRoot)) {
      const projectDir = join(sessionsRoot, project);
      const projectStat = await stat(projectDir).catch(() => null);
      if (projectStat === null || !projectStat.isDirectory()) {
        continue;
      }
      for (const session of await readdir(projectDir)) {
        const sessionDir = join(projectDir, session);
        const sessionStat = await stat(sessionDir).catch(() => null);
        if (sessionStat === null || !sessionStat.isDirectory()) {
          continue;
        }
        for (const file of await readdir(sessionDir)) {
          if (file !== "session.jsonl" && file !== "session.jsonl.zstd") {
            continue;
          }
          const path = join(sessionDir, file);
          const fileStat = await stat(path).catch(() => null);
          if (fileStat !== null) {
            candidates.push({ mtimeMs: fileStat.mtimeMs, path });
          }
        }
      }
    }
  } catch {
    return { sessionId: null, eventLogHead: null };
  }
  if (candidates.length === 0) {
    return { sessionId: null, eventLogHead: null };
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newest = candidates[0]!;
  const bytes = await readFile(newest.path);
  const raw = newest.path.endsWith(".zstd") ? decodeSessionFrames(bytes) : bytes.toString("utf8");
  return {
    sessionId: basename(dirname(newest.path)),
    eventLogHead: sha256(raw),
    observation: sessionObservation(raw),
  };
}

/** DSH appends independent Zstandard frames; Node decodes only one per call. */
export function decodeSessionFrames(bytes: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  let remaining = 32 * 1024 * 1024;
  while (offset < bytes.length) {
    // Validate complete frame boundaries first: Node can accept a truncated final frame.
    let end = offset;
    const advance = (count: number) => { end += count; if (end > bytes.length) throw new Error("Truncated compressed session frame"); };
    advance(5);
    const descriptor = bytes[offset + 4]!;
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528 || (descriptor & 0x18) !== 0) throw new Error("Invalid compressed session frame");
    const singleSegment = (descriptor & 0x20) !== 0;
    const contentSizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    advance((singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag));
    for (;;) {
      advance(3);
      const block = bytes.readUIntLE(end - 3, 3);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error("Invalid compressed session block");
      advance(type === 1 ? 1 : block >>> 3);
      if ((block & 1) !== 0) break;
    }
    if ((descriptor & 4) !== 0) advance(4);
    const decoded = zstdDecompressSync(bytes.subarray(offset, end), { maxOutputLength: remaining });
    chunks.push(decoded);
    remaining -= decoded.length;
    offset = end;
    if (remaining <= 0 && offset < bytes.length) throw new Error("Session evidence exceeds bound");
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Extract counters and protocol facts, never retain transcript content. */
export function sessionObservation(raw: string) {
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let usageObserved = false;
  const getOrderCalls = new Set<string>();
  let getOrderSucceeded = false;
  let done = false;
  for (const line of raw.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as { type?: string; data?: { name?: string; callId?: string; error?: unknown; usage?: { inputTokens?: number; outputTokens?: number }; message?: { source?: { callId?: string }; content?: Array<{ type?: string; text?: string }> } } };
    if (event.type === "tool/call") { toolCalls++; if (event.data?.name === "get_order" && event.data.callId) getOrderCalls.add(event.data.callId); }
    if (event.type === "tool/result" && !event.data?.error && getOrderCalls.has(event.data?.message?.source?.callId ?? "")) getOrderSucceeded = true;
    if (event.type === "assistant/message") {
      const usage = event.data?.usage;
      if (usage && Number.isSafeInteger(usage.inputTokens) && Number(usage.inputTokens) >= 0 && Number.isSafeInteger(usage.outputTokens) && Number(usage.outputTokens) >= 0) {
        input += usage.inputTokens!; output += usage.outputTokens!; usageObserved = true;
      }
      if (getOrderSucceeded && event.data?.message?.content?.some(block => block.type === "text" && block.text?.trim() === "DONE")) done = true;
    }
  }
  return { tool_calls: toolCalls, ...(usageObserved ? { input_tokens: input, output_tokens: output } : {}), get_order_succeeded: getOrderSucceeded, get_order_then_done: getOrderSucceeded && done };
}

/** Whether the docker daemon answers a trivial query. */
function dockerHealthy(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 10_000 }).status === 0;
}

/** Ensure the docker daemon answers; on macOS relaunch Docker Desktop and wait. */
async function ensureDocker(): Promise<void> {
  if (dockerHealthy()) {
    return;
  }
  spawnSync("open", ["-a", "Docker"], { timeout: 15_000 });
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (dockerHealthy()) {
      return;
    }
  }
  throw new Error("Docker daemon unavailable and did not recover after relaunching Docker Desktop");
}

function cleanupTopology(topology: DockerTopology, owned: Array<{ kind: "container" | "network"; id: string }>): void {
  for (const resource of [...owned].reverse()) {
    const inspected = spawnSync("docker", [resource.kind, "inspect", "--format", resource.kind === "network" ? '{{index .Labels "dal.e2e.attempt"}}' : '{{index .Config.Labels "dal.e2e.attempt"}}', resource.id], { encoding: "utf8", timeout: 30_000 });
    if (inspected.status !== 0 || inspected.stdout.trim() !== topology.id) continue;
    spawnSync("docker", resource.kind === "container" ? ["rm", "-f", resource.id] : ["network", "rm", resource.id], { encoding: "utf8", timeout: 30_000 });
  }
}

function requireDockerSuccess(argv: string[], label: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("docker", argv, { encoding: "utf8", timeout: 120_000, env });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} failed (docker status ${result.status ?? "unavailable"})`);
  }
  return result.stdout.trim();
}

function dockerLauncherEnv(capabilities: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...capabilities };
  for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function waitForService(container: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = spawnSync(
      "docker",
      ["exec", container, "node", "-e", `fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (probe.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("isolated workflow service did not become healthy");
}

async function runTask(
  args: Map<string, string>,
  taskId: string,
  batch: string,
  approvedImageDigest: string,
  approvedManifestDigest: string,
  attempt: number,
): Promise<{ task: WorkflowTask; verdict: ReturnType<typeof gradeTask>; state: unknown; durationMs: number; prompt: string; modelPatchSha256: string; receiptPath: string; runId: string; observation?: ReturnType<typeof sessionObservation> }> {
  const task = JSON.parse(await readFile(join(workspace, "tasks", taskId), "utf8")) as WorkflowTask;
  const prompt = promptFor(taskId);
  const provider = args.get("provider") ?? "deepseek-official";
  const model = args.get("model") ?? "deepseek-v4-flash";
  const faults = faultProfile(args);
  const resolutions = resolutionProfile(args);
  const runId = plannedRunId(args, taskId, attempt);
  const attemptId = runId;
  const mode = executionMode(args);
  const policy = gatewayPolicyTemplate(args, runId);
  const ledgerRoot = await gatewayLedgerRoot(args);
  await assertTransmissionManifestCurrent(args, approvedImageDigest, approvedManifestDigest);
  if (mode === "live") {
    const approval = args.get("approval");
    if (!approval) throw new Error("Live execution requires --approval");
    const decision = await verifyApprovalFile(approval, { action: "send_data_externally", scope: approvedManifestDigest, at: new Date() });
    if (decision.decision_id !== policy.approval_id) throw new Error("Approval identity does not match the gateway policy");
    const keyEnv = policy.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    if (!process.env[keyEnv]?.trim()) throw new Error(`Live gateway requires launcher environment ${keyEnv}; no attempt was claimed`);
  }
  const gatewayRoot = join(repoRoot, ".dal", "check", "e2e-gateways", runId);
  await mkdir(gatewayRoot, { recursive: true, mode: 0o700 });
  // Claim before staging or service initialization so replay cannot overwrite attempt evidence.
  const policyPath = join(gatewayRoot, "policy.json");
  await writeFile(policyPath, `${canonicalJson(policy)}\n`, { flag: "wx", mode: 0o400 });
  const stateRootHost = join(workspace, SERVICE_ROOT, batch, attemptId);
  await mkdir(stateRootHost, { recursive: true, mode: 0o700 });
  const seedState: ServiceState = {
    orders: (task.initial_state.orders ?? {}) as ServiceState["orders"],
    refunds: (task.initial_state.refunds ?? []) as ServiceState["refunds"],
    labels: (task.initial_state.labels ?? []) as ServiceState["labels"],
    bookings: (task.initial_state.bookings ?? {}) as ServiceState["bookings"],
  };
  const resetServiceState = async (): Promise<void> => {
    await initializeService({ stateRoot: stateRootHost, faults, resolutions }, seedState);
  };
  await resetServiceState();
  const beforeDigest = sha256(stableJson(projectServiceState(seedState)));

  const compositionPatch = renderedCompositionPatch(args);
  const modelPatch = compositionPatch;
  const stageRoot = join(workspace, ".dal", "benchmark", "e2e", "staging", attemptId);
  await stageCandidateWorkspace({
    stageRoot,
    taskId,
    agentTask: agentVisibleTask(task),
    compositionPatch,
    skillPath: (await selectedSkillArtifact(args)).path,
    policyPath: POLICY_PATH,
  });
  const graderRoot = join(workspace, ".dal", "benchmark", "e2e", "grader", attemptId);
  await mkdir(graderRoot, { recursive: true, mode: 0o700 });
  const graderTaskPath = join(graderRoot, "task.json");
  await writeFile(graderTaskPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const currentManifest = await assertTransmissionManifestCurrent(args, approvedImageDigest, approvedManifestDigest);
  const stagedSkillDigest = sha256(await readFile(join(stageRoot, ".agents", "skills", "refund-workflow", "SKILL.md")));
  if (stagedSkillDigest !== currentManifest.skill_sha256) {
    throw new Error("Staged candidate skill does not match the approved transmission manifest");
  }
  const stagedWorkspaceDigest = await dirDigest(stageRoot);
  const stagedGraderTaskDigest = sha256(stableJson(JSON.parse(await readFile(graderTaskPath, "utf8")) as unknown));
  const approvedGraderTask = currentManifest.evaluator_tasks.find((entry) => entry.task_id === taskId);
  if (approvedGraderTask?.sha256 !== stagedGraderTaskDigest) {
    throw new Error("Staged grader task does not match the approved transmission manifest");
  }

  if (mode === "live") {
    const approval = args.get("approval");
    if (!approval) throw new Error("Live execution requires --approval");
    const decision = await verifyApprovalFile(approval, { action: "send_data_externally", scope: approvedManifestDigest, at: new Date() });
    if (decision.decision_id !== policy.approval_id) throw new Error("Approval identity does not match the gateway policy");
  }
  const gatewayToken = randomBytes(32).toString("hex");
  await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });

  const dshHomeHost = join(workspace, ".dal", "benchmark", "e2e", "dsh-home", attemptId);
  await mkdir(dshHomeHost, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const runner = args.get("runner") ?? "docker";
  if (runner !== "docker") {
    throw new Error("The integrity benchmark requires --runner docker; local execution cannot isolate the oracle");
  }
  const topology = topologyFor(attemptId);
  const imageReference = `sha256:${approvedImageDigest}`;
  const evaluatorToken = randomBytes(32).toString("hex");
  let graded!: {
    state: unknown;
    effects: WorkflowEffectObservation[];
    journal_sha256: string;
    verdict: Verdict;
  };
  await ensureDocker();
  const owned: Array<{ kind: "container" | "network"; id: string }> = [];
  let gatewayStarted = false;
  let candidateId: string | undefined;
  const createContainer = (argv: string[], label: string, env: NodeJS.ProcessEnv): string => {
    const id = requireDockerSuccess(["create", ...argv.slice(1).filter(value => value !== "--rm" && value !== "--detach")], label, env);
    owned.push({ kind: "container", id });
    return id;
  };
  try {
    for (const argv of networkDockerArgv(topology, mode)) {
      owned.push({ kind: "network", id: requireDockerSuccess(argv, "network creation") });
    }
    if (mode === "live") await verifyApprovalFile(args.get("approval")!, { action: "send_data_externally", scope: approvedManifestDigest, at: new Date() });
    const gatewayEnv = dockerLauncherEnv({ DAL_GATEWAY_TOKEN: gatewayToken });
    if (mode === "live") {
      const keyEnv = policy.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      const key = process.env[keyEnv];
      if (!key) throw new Error(`Live gateway requires launcher environment ${keyEnv}`);
      gatewayEnv[keyEnv] = key;
    }
    const gatewayId = createContainer(gatewayDockerArgv({ image: imageReference, topology, policyPath, ledgerRoot, mode, provider: policy.provider }), "gateway creation", gatewayEnv);
    requireDockerSuccess(["start", gatewayId], "gateway launch");
    gatewayStarted = true;
    if (mode === "live") requireDockerSuccess(["network", "connect", topology.outboundNetwork, topology.gatewayContainer], "gateway outbound attachment");
    await waitForService(topology.gatewayContainer);
    const serviceEnv = dockerLauncherEnv({
      DAL_SERVICE_FAULTS: JSON.stringify(faults),
      DAL_SERVICE_RESOLUTIONS: JSON.stringify(resolutions),
      DAL_EVALUATOR_TOKEN: evaluatorToken,
    });
    const serviceId = createContainer(
      serviceDockerArgv({ image: imageReference, topology, stateRootHost }),
      "workflow service container",
      serviceEnv,
    );
    requireDockerSuccess(["start", serviceId], "service launch");
    requireDockerSuccess(
      ["network", "connect", "--alias", SERVICE_ALIAS, topology.graderNetwork, topology.serviceContainer],
      "grader network attachment",
    );
    await waitForService(topology.serviceContainer);

    const argv = candidateDockerArgv({
      image: imageReference,
      topology,
      stageRoot,
      dshHomeHost,
      prompt,
    });
    candidateId = createContainer(argv, "candidate creation", dockerLauncherEnv({ DAL_GATEWAY_TOKEN: gatewayToken }));
    const graderId = createContainer(graderDockerArgv({ image: imageReference, topology, taskPath: graderTaskPath }), "grader creation", dockerLauncherEnv({ DAL_EVALUATOR_TOKEN: evaluatorToken }));
    const captureIsolation = () => {
      const internalNetworks = [topology.candidateNetwork, topology.graderNetwork];
      const networkFacts = [...internalNetworks, ...(mode === "live" ? [topology.outboundNetwork] : [])].map(name => {
        const info = JSON.parse(requireDockerSuccess(["network", "inspect", "--format", "{{json .}}", name], "network inspection")) as { Internal: boolean; Labels: Record<string, string> };
        if (info.Internal !== internalNetworks.includes(name) || info.Labels["dal.e2e.attempt"] !== topology.id) throw new Error("Network isolation inspection failed");
        return { name, internal: info.Internal };
      });
      const imageEnv = ["PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV"];
      const principals = [
        { principal: "candidate", id: candidateId!, networks: [topology.candidateNetwork], envNames: [...imageEnv, "DSH_HOME", "DAL_GATEWAY_TOKEN"], mounts: [{ source: stageRoot, destination: "/workspace", writable: false }, { source: dshHomeHost, destination: "/dsh-home", writable: true }] },
        { principal: "service", id: serviceId, networks: internalNetworks, envNames: [...imageEnv, "DAL_SERVICE_STATE_ROOT", "DAL_SERVICE_PORT", "DAL_SERVICE_FAULTS", "DAL_SERVICE_RESOLUTIONS", "DAL_EVALUATOR_TOKEN"], mounts: [{ source: stateRootHost, destination: "/service-state", writable: true }] },
        { principal: "grader", id: graderId, networks: [topology.graderNetwork], envNames: [...imageEnv, "DAL_EVALUATOR_TOKEN"], mounts: [{ source: graderTaskPath, destination: "/oracle/task.json", writable: false }] },
        { principal: "gateway", id: gatewayId, networks: [topology.candidateNetwork, ...(mode === "live" ? [topology.outboundNetwork] : [])], envNames: [...imageEnv, "DAL_GATEWAY_POLICY", "DAL_GATEWAY_LEDGER_ROOT", "DAL_GATEWAY_MODE", "DAL_GATEWAY_TOKEN", ...(mode === "live" ? [policy.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"] : [])], mounts: [{ source: policyPath, destination: "/gateway-policy.json", writable: false }, { source: ledgerRoot, destination: "/gateway-ledger", writable: true }] },
      ].map(expected => {
        const inspection = JSON.parse(requireDockerSuccess(["container", "inspect", "--format", "{{json .}}", expected.id], "container inspection")) as ContainerInspection;
        return { principal: expected.principal, ...containerIsolationFacts(inspection, { ...expected, image: imageReference }) };
      });
      return { run_id: runId, mode, source: "docker-inspect", candidate_egress: "denied-by-internal-only-network", networks: networkFacts, principals };
    };
    await writeFile(join(gatewayRoot, "isolation-before.json"), `${canonicalJson(captureIsolation())}\n`, { flag: "wx", mode: 0o600 });
    const result = spawnSync("docker", ["start", "--attach", candidateId], {
        encoding: "utf8",
        timeout: 900_000,
        maxBuffer: 32 * 1024 * 1024,
        env: dockerLauncherEnv({}),
      });
    if (mode === "rehearsal") {
      await writeFile(join(gatewayRoot, "candidate-diagnostics.json"), `${canonicalJson({ exit_code: result.status, transport_error: result.error !== undefined, final_done: (result.stdout ?? "").trim() === "DONE", stderr_bytes: Buffer.byteLength(result.stderr ?? "") })}\n`, { flag: "wx", mode: 0o600 });
    }
    if (result.error !== undefined) {
      throw new Error(`dsh headless transport failed for ${taskId}; no retry`);
    }
    if (result.status !== 0) {
      throw new Error(`dsh headless exited ${result.status} for ${taskId}`);
    }

    const grader = spawnSync(
      "docker",
      ["start", "--attach", graderId],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: dockerLauncherEnv({}),
      },
    );
    if (grader.error !== undefined || grader.status !== 0) {
      throw new Error(`isolated grader failed for ${taskId}`);
    }
    graded = JSON.parse(grader.stdout.trim()) as typeof graded;
    await writeFile(join(gatewayRoot, "isolation-after.json"), `${canonicalJson(captureIsolation())}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    try {
      if (candidateId) requireDockerSuccess(["stop", "--time", "5", candidateId], "candidate quiescence");
      if (gatewayStarted) {
        const raw = requireDockerSuccess(["exec", topology.gatewayContainer, "node", "-e", "fetch('http://127.0.0.1:8787/receipt',{headers:{authorization:'Bearer '+process.env.DAL_GATEWAY_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"], "gateway receipt");
        const receipt = safeGatewayReceipt(JSON.parse(raw), policy, mode);
        await writeFile(join(gatewayRoot, "receipt.json"), `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o600 });
        console.log(`gateway\t${runId}\treserved_microusd=${receipt.reserved_microusd}\taccounting=upper-bound-reservations-no-refund`);
        for (const failure of receipt.failure_diagnostics?.records ?? []) console.log(`gateway-failure\tstage=${failure.stage}\tcode=${failure.code}\tupstream_status=${failure.upstream_status ?? "unavailable"}`);
      }
    } finally { cleanupTopology(topology, owned); }
  }
  const durationMs = Date.now() - started;

  const state = graded.state;
  const verdict = graded.verdict;
  const afterDigest = sha256(stableJson(state));
  if (await dirDigest(stageRoot) !== stagedWorkspaceDigest) {
    throw new Error("Candidate staging changed during execution; refusing the receipt");
  }
  if (sha256(stableJson(JSON.parse(await readFile(graderTaskPath, "utf8")) as unknown)) !== stagedGraderTaskDigest) {
    throw new Error("Grader staging changed during execution; refusing the receipt");
  }
  const { sessionId, eventLogHead, observation } = await captureSession(dshHomeHost);
  if (!observation) throw new Error("Missing readable session counters; refusing invented run metrics");
  if (mode === "rehearsal") {
    const protocolSuccess = observation?.get_order_then_done === true;
    await writeFile(join(gatewayRoot, "rehearsal.json"), `${canonicalJson({ mode, protocol_success: protocolSuccess, observation, business_success: verdict.pass, accounting: "synthetic-reservations-not-billing" })}\n`, { flag: "wx", mode: 0o600 });
    console.log(`rehearsal\tprotocol=${protocolSuccess ? "passed" : "unproven"}\tbusiness=${verdict.pass ? "passed" : "failed"}`);
    if (!protocolSuccess) throw new Error("Rehearsal protocol not proven: require recorded get_order followed by DONE");
  }
  const imageDigest = approvedImageDigest;
  const toolsDigest = currentManifest.workflow_tools_sha256;
  const compositionDigest = sha256(
    canonicalJson({
      patch: compositionPatch,
      skill: stagedSkillDigest,
      staged_workspace: stagedWorkspaceDigest,
      workflow_tools: toolsDigest,
      container_image: imageDigest,
      isolation: "candidate-service-grader-v1",
    }),
  );
  const generation = currentManifest.generation;
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: `rcp-${task.task_id}-${randomUUID().slice(0, 8)}`,
    run_id: runId,
    created_at: new Date().toISOString(),
    candidate_sha256: stagedSkillDigest,
    base_generation_id: generation,
    candidate_generation_id: generation,
    effective_composition_sha256: compositionDigest,
    task_handle: taskId,
    model: { provider, model },
    model_patch_sha256: sha256(modelPatch),
    dsh_session_id: sessionId,
    event_log_head_sha256: eventLogHead,
    business_effect_log_head_sha256: graded.journal_sha256,
    container_image_sha256: imageDigest,
    transmission_manifest_sha256: approvedManifestDigest,
    external_state_before_sha256: beforeDigest,
    external_state_after_sha256: afterDigest,
    grader_receipt_sha256: sha256(stableJson(verdict)),
    source: "repo://benchmarks/tau-style-workflow/run-e2e.ts",
    isolation: {
      topology: "candidate-service-grader-v1",
      candidate_workspace_sha256: stagedWorkspaceDigest,
      candidate_workspace_read_only: true,
      candidate_repository_mounted: false,
      service_state_access: "typed-endpoint-only",
      oracle_access: "grader-only",
    },
    business_outcome: {
      status: verdict.pass ? "passed" : "failed",
      source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
      score: verdict.score,
      earned: verdict.earned,
      total: verdict.total,
    },
  };
  const receiptDirectory = mode === "rehearsal" ? join(await e2eRunStore(args), "receipts") : join(repoRoot, ".dal", "check", "e2e-receipts");
  await assertRealDirectoryAncestors(receiptDirectory);
  const receiptPath = join(receiptDirectory, `${receipt.receipt_id}.json`);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return {
    task,
    verdict,
    state,
    durationMs,
    prompt,
    modelPatchSha256: sha256(modelPatch),
    receiptPath: relative(repoRoot, receiptPath),
    runId,
    ...(observation ? { observation } : {}),
  };
}

async function main(): Promise<void> {
  const positionals = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const args = argumentsFrom(process.argv.slice(2));
  if (positionals[0] === "manifest-digest") {
    console.log(await manifestDigest(args));
    return;
  }
  const mode = executionMode(args);
  const approval = args.get("approval");
  if (mode === "live" && approval === undefined && args.get("prepare") !== "true" && args.get("manifest") === undefined) {
    throw new Error("Usage: run-e2e.ts --approval <decision-file> [--runner docker] [--tasks a.json,b.json] [--batch <id>] [--store <dir>] [--attempts N] [--compare <summary-file>] [--faults issue_refund=unknown,...] [--resolutions issue_refund=success,...] [--generation g0|g1] [--skill <repo-local.md>] [--provider <p>] [--model <m>]");
  }
  const tasks = await taskIds(args);
  const manifest = await transmissionManifest(args);
  const approvedImageDigest = requireManifestImageDigest(manifest);
  const digest = sha256(canonicalJson(manifest));
  console.error(`manifest digest: ${digest}`);
  if (args.get("prepare") === "true" || args.get("manifest") !== undefined) {
    const path = await persistTransmissionManifest(manifest, digest);
    if (args.get("manifest")) await writeFile(resolve(args.get("manifest")!), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ manifest_path: path, manifest_sha256: digest }));
    return;
  }
  if (mode === "live") await verifyApprovalFile(approval!, { action: "send_data_externally", scope: digest, at: new Date() });
  const manifestPath = await persistTransmissionManifest(manifest, digest);

  const store = await e2eRunStore(args);
  const batch = args.get("batch") ?? "baseline";
  const skillDigest = manifest.skill_sha256;
  const goalDigest = (task: WorkflowTask): string => sha256(stableJson(task.goal_state));
  const model = args.get("model") ?? "deepseek-v4-flash";
  const provider = args.get("provider") ?? "deepseek-official";
  const selectedGeneration = generationLabel(args);
  const attemptsPerTask = attemptCount(args);
  let failed = 0;
  const perTask: TaskSummary[] = [];
  for (const taskId of tasks) {
    const taskSummary: TaskSummary = {
      task_id: taskId,
      attempts: attemptsPerTask,
      passed: 0,
      mean: 0,
      pass_at_1: false,
      checkpoint_pass: false,
      attempts_detail: [],
    };
    for (let attempt = 1; attempt <= attemptsPerTask; attempt += 1) {
      const { task, verdict, state, durationMs, prompt, modelPatchSha256, receiptPath, runId, observation } = await runTask(
        args,
        taskId,
        batch,
        approvedImageDigest,
        digest,
        attempt,
      );
      const passed = verdict.pass;
      if (!passed) {
        failed += 1;
      } else {
        taskSummary.passed += 1;
      }
      if (attempt === 1 && passed) {
        taskSummary.pass_at_1 = true;
      }
      const record = {
        $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
        schema_version: "1.0.0",
        run_id: runId,
        task_id: taskId,
        change_id: `chg-e2e-${batch}`,
        started_at: new Date(Date.now() - durationMs).toISOString(),
        finished_at: new Date().toISOString(),
        outcome: "succeeded",
        failure: null,
        context: {
          task_set: "tau-style-workflow-e2e",
          environment_snapshot: `${process.platform} ${process.arch} node ${process.versions.node}`,
          tool_versions: [],
          model: { id: model, version: provider },
          prompt_sha256: sha256(prompt),
          harness_sha256: null,
          grader_version: GRADER_VERSION,
          seeds: [],
          context_policy_sha256: sha256(await readFile(join(workspace, "tasks", "policy.md"), "utf8")),
          inference_parameters: [],
          harness_pins: [
            {
              surface: "skills",
              uri: manifest.skill_source_uri ?? "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
              sha256: skillDigest,
            },
            {
              surface: "prompt",
              uri: "repo://benchmarks/tau-style-workflow/run-e2e.ts",
              sha256: sha256(prompt),
            },
            {
              surface: "model_patch",
              uri: "repo://benchmarks/tau-style-workflow/.dal/benchmark/e2e/model-patch.yml",
              sha256: modelPatchSha256,
            },
          ],
          model_patch_sha256: modelPatchSha256,
        },
        artifacts: [],
        batch_id: batch,
        checks: verdict.checks.map((check) => ({
          id: check.id,
          pass: check.pass,
          detail: check.detail,
          goal_sha256: goalDigest(task),
          actual_sha256: sha256(stableJson(state)),
          ...(check.weight === undefined ? {} : { weight: check.weight }),
          ...(check.gated === undefined ? {} : { gated: check.gated }),
        })),
        business_outcome: {
          status: verdict.pass ? "passed" : "failed",
          source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
          score: verdict.score,
          earned: verdict.earned,
          total: verdict.total,
        },
        metrics: { duration_ms: durationMs, ...(observation ? { tool_calls: observation.tool_calls, ...(observation.input_tokens === undefined ? {} : { input_tokens: observation.input_tokens, output_tokens: observation.output_tokens }) } : {}) },
        evidence: [`dal-e2e-mode://${mode}`, `dsh-session://e2e-${task.task_id}`, `repo://${receiptPath}`, `repo://.dal/check/e2e-gateways/${runId}/receipt.json`,
          `repo://.dal/check/e2e-gateways/${runId}/isolation-before.json`, `repo://.dal/check/e2e-gateways/${runId}/isolation-after.json`,
          ...(mode === "rehearsal" ? [`repo://.dal/check/e2e-gateways/${runId}/rehearsal.json`] : [])],
        privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
      };
      const recordDirectory = mode === "rehearsal" ? join(await e2eRunStore(args), "staged") : join(workspace, ".dal", "benchmark", "e2e");
      await assertRealDirectoryAncestors(recordDirectory);
      await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
      const recordPath = join(recordDirectory, `${runId}.json`);
      const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(recordPath, recordRaw, "utf8");
      await ingestRunRecord(recordPath, await e2eRunStore(args));
      const receiptAbsolute = resolve(repoRoot, receiptPath);
      const receiptRaw = await readFile(receiptAbsolute);
      taskSummary.attempts_detail.push({
        attempt,
        run_id: runId,
        run_record_path: relative(repoRoot, recordPath),
        run_record_sha256: sha256(recordRaw),
        receipt_path: relative(repoRoot, receiptAbsolute),
        receipt_sha256: sha256(receiptRaw.toString("utf8")),
        state_sha256: sha256(stableJson(state)),
        passed,
      });
      const checks = verdict.checks.map((check) => `${check.pass ? "ok" : "FAIL"}:${check.id}`).join(" ");
      console.log(`${task.task_id}#${attempt}\t${passed ? "passed" : "failed"}\t${checks}`);
    }
    taskSummary.checkpoint_pass = taskSummary.passed > 0;
    taskSummary.mean = taskSummary.passed / attemptsPerTask;
    perTask.push(taskSummary);
  }

  const outcomes: number[] = perTask.flatMap((task) => task.attempts_detail.map((detail) => (detail.passed ? 1 : 0)));
  const mean = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const meanOfSquares = outcomes.length === 0 ? 0 : outcomes.reduce((sum, value) => sum + value * value, 0) / outcomes.length;
  const passAt1 = perTask.length === 0 ? 0 : perTask.filter((task) => task.pass_at_1).length / perTask.length;
  const checkpointRate = perTask.length === 0 ? 0 : perTask.filter((task) => task.checkpoint_pass).length / perTask.length;
  const summary: E2eSummary = {
    format: "e2e-summary-v1",
    summary_id: `esm-${batch}-${randomUUID().slice(0, 8)}`,
    created_at: new Date().toISOString(),
    batch,
    task_set: tasks,
    model: { provider, model },
    generation: selectedGeneration,
    candidate_sha256: skillDigest,
    benchmark_context_sha256: manifest.benchmark_context_sha256,
    transmission_manifest_path: manifestPath,
    transmission_manifest_sha256: digest,
    runner: args.get("runner") ?? "docker",
    faults: args.get("faults") ?? null,
    resolutions: args.get("resolutions") ?? null,
    attempts_per_task: attemptsPerTask,
    per_task: perTask,
    overall: {
      mean_success_rate: mean,
      pass_at_1: passAt1,
      checkpoint_rate: checkpointRate,
      variance: meanOfSquares - mean * mean,
    },
  };
  const summaryDirectory = mode === "rehearsal" ? join(store, "summaries") : join(repoRoot, ".dal", "check");
  await assertRealDirectoryAncestors(summaryDirectory);
  const summaryPath = join(summaryDirectory, `e2e-summary-${batch}.json`);
  await mkdir(summaryDirectory, { recursive: true, mode: 0o700 });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  for (const task of perTask) {
    console.log(
      `${task.task_id}\t${task.passed}/${task.attempts} passed\tmean ${task.mean.toFixed(2)}\tpass@1 ${task.pass_at_1 ? "yes" : "no"}\tcheckpoint ${task.checkpoint_pass ? "yes" : "no"}`,
    );
  }
  console.log(
    `summary\t${perTask.filter((task) => task.checkpoint_pass).length}/${perTask.length} checkpoint-passed\tmean ${mean.toFixed(2)}\tpass@1 ${passAt1.toFixed(2)}\t${summaryPath}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;

  const compare = args.get("compare");
  if (compare !== undefined) {
    const reference = await readSummary(resolve(process.cwd(), compare));
    const gate = await compareGate(summary, reference, repoRoot);
    console.log(`compare\t${gate.pass ? "pass" : "fail"}\t${[...gate.problems, ...gate.notes].join("; ")}`);
    if (!gate.pass) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
