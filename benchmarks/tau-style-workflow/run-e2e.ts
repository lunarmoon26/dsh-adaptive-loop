import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyApprovalFile } from "../../src/approval.js";
import { loadDotEnv } from "../../src/docker.js";
import { canonicalJson, sha256 } from "../../src/json.js";
import { ingestRunRecord } from "../../src/runs.js";
import { buildCompositionPatch, buildModelPatch, promptFor, providerSpec } from "./e2e-prompt.js";
import { compareGate, readSummary, type E2eSummary, type TaskSummary } from "./e2e-summary.js";
import {
  candidateDockerArgv,
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
  return buildCompositionPatch(
    args.get("provider") ?? "deepseek-official",
    args.get("model") ?? "deepseek-v4-flash",
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
async function containerImageDigest(): Promise<string | null> {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", DEFAULT_IMAGE], { encoding: "utf8", timeout: 30_000 });
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
    ["run", "--rm", image, "sh", "-c", `cd ${containerDir} && find . -type f | sort | xargs sha256sum | sha256sum`],
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
  const imageDigest = pinnedImageDigest ?? await containerImageDigest();
  const imageReference = imageDigest === null ? DEFAULT_IMAGE : `sha256:${imageDigest}`;
  const policyDigest = sha256(await readFile(POLICY_PATH, "utf8"));
  const skillDigest = sha256(await readFile(SKILL_PATH, "utf8"));
  const workflowToolsDigest = await containerDirDigest(imageReference, "/opt/dal/plugins/dal-workflow-tools");
  if (workflowToolsDigest === null) {
    throw new Error(`Unable to inspect workflow tools in ${imageReference}; refusing an incomplete transmission manifest`);
  }
  const prompts = tasks.map((taskId) => ({ task_id: taskId, prompt: promptFor(taskId) }));
  const driverSources = {
    run_e2e_sha256: sha256(await readFile(join(workspace, "run-e2e.ts"), "utf8")),
    prompt_sha256: sha256(await readFile(join(workspace, "e2e-prompt.ts"), "utf8")),
    summary_sha256: sha256(await readFile(join(workspace, "e2e-summary.ts"), "utf8")),
    topology_sha256: sha256(await readFile(join(workspace, "e2e-topology.ts"), "utf8")),
  };
  const benchmarkContext = {
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
  const count = raw === undefined ? 1 : Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1) {
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
async function captureSession(homeRoot: string): Promise<{ sessionId: string | null; eventLogHead: string | null }> {
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
          if (!file.startsWith("session.jsonl")) {
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
  return {
    sessionId: basename(dirname(newest.path)),
    eventLogHead: sha256(await readFile(newest.path, "utf8")),
  };
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

function cleanupTopology(topology: DockerTopology): void {
  for (const container of [topology.candidateContainer, topology.graderContainer, topology.serviceContainer]) {
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf8", timeout: 30_000 });
  }
  for (const network of [topology.candidateNetwork, topology.graderNetwork]) {
    spawnSync("docker", ["network", "rm", network], { encoding: "utf8", timeout: 30_000 });
  }
}

function requireDockerSuccess(argv: string[], label: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("docker", argv, { encoding: "utf8", timeout: 120_000, env });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message ?? String(result.stderr).slice(-500)}`);
  }
  return result.stdout.trim();
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
): Promise<{ task: WorkflowTask; verdict: ReturnType<typeof gradeTask>; state: unknown; durationMs: number; prompt: string; modelPatchSha256: string; receiptPath: string; runId: string }> {
  const task = JSON.parse(await readFile(join(workspace, "tasks", taskId), "utf8")) as WorkflowTask;
  const prompt = promptFor(taskId);
  const provider = args.get("provider") ?? "deepseek-official";
  const model = args.get("model") ?? "deepseek-v4-flash";
  const faults = faultProfile(args);
  const resolutions = resolutionProfile(args);
  const attemptId = `${batch}-${task.task_id}-${randomUUID().slice(0, 8)}`;
  const runId = `run-e2e-${task.task_id}-${batch}-${randomUUID().slice(0, 8)}`;
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

  const modelPatch = buildModelPatch(provider, model);
  const compositionPatch = renderedCompositionPatch(args);
  const stageRoot = join(workspace, ".dal", "benchmark", "e2e", "staging", attemptId);
  await stageCandidateWorkspace({
    stageRoot,
    taskId,
    agentTask: agentVisibleTask(task),
    compositionPatch,
    skillPath: SKILL_PATH,
    policyPath: POLICY_PATH,
  });
  const graderRoot = join(workspace, ".dal", "benchmark", "e2e", "grader", attemptId);
  await mkdir(graderRoot, { recursive: true, mode: 0o700 });
  const graderTaskPath = join(graderRoot, "task.json");
  await writeFile(graderTaskPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const currentManifest = await assertTransmissionManifestCurrent(args, approvedImageDigest, approvedManifestDigest);
  const stagedSkillDigest = sha256(await readFile(join(stageRoot, ".agents", "skills", "refund-workflow", "SKILL.md"), "utf8"));
  if (stagedSkillDigest !== currentManifest.skill_sha256) {
    throw new Error("Staged candidate skill does not match the approved transmission manifest");
  }
  const stagedWorkspaceDigest = await dirDigest(stageRoot);
  const stagedGraderTaskDigest = sha256(stableJson(JSON.parse(await readFile(graderTaskPath, "utf8")) as unknown));
  const approvedGraderTask = currentManifest.evaluator_tasks.find((entry) => entry.task_id === taskId);
  if (approvedGraderTask?.sha256 !== stagedGraderTaskDigest) {
    throw new Error("Staged grader task does not match the approved transmission manifest");
  }

  const keyEnv = providerSpec(provider).apiKeyEnv;
  const key = process.env[keyEnv] ?? loadDotEnv(repoRoot)[keyEnv] ?? "";
  if (key === "") {
    throw new Error(`Provider "${provider}" needs ${keyEnv}; set it in the environment or ${repoRoot}/.env before running`);
  }

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
  cleanupTopology(topology);
  try {
    requireDockerSuccess(["network", "create", topology.candidateNetwork], "candidate network creation");
    requireDockerSuccess(["network", "create", "--internal", topology.graderNetwork], "grader network creation");
    const serviceEnv = {
      ...process.env,
      DAL_SERVICE_FAULTS: JSON.stringify(faults),
      DAL_SERVICE_RESOLUTIONS: JSON.stringify(resolutions),
      DAL_EVALUATOR_TOKEN: evaluatorToken,
    };
    requireDockerSuccess(
      serviceDockerArgv({ image: imageReference, topology, stateRootHost }),
      "workflow service container",
      serviceEnv,
    );
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
      keyEnv,
      prompt,
    });
    let result: ReturnType<typeof spawnSync> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = spawnSync("docker", argv, {
        encoding: "utf8",
        timeout: 900_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, [keyEnv]: key },
      });
      if (result.error === undefined || attempt === 1) break;
      console.error(`docker transport failure for ${taskId}: ${result.error.message}; cleaning the candidate and retrying once`);
      spawnSync("docker", ["rm", "-f", topology.candidateContainer], { encoding: "utf8", timeout: 30_000 });
      await resetServiceState();
      await ensureDocker();
    }
    if (result === undefined || result.error !== undefined) {
      throw new Error(`dsh headless failed to start for ${taskId}: ${result?.error?.message ?? "unknown transport error"}`);
    }
    if (result.status !== 0) {
      throw new Error(`dsh headless exited ${result.status} for ${taskId}: ${String(result.stderr).slice(-500)}`);
    }

    const grader = spawnSync(
      "docker",
      graderDockerArgv({ image: imageReference, topology, taskPath: graderTaskPath }),
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, DAL_EVALUATOR_TOKEN: evaluatorToken },
      },
    );
    if (grader.error !== undefined || grader.status !== 0) {
      throw new Error(`isolated grader failed for ${taskId}: ${grader.error?.message ?? String(grader.stderr).slice(-500)}`);
    }
    graded = JSON.parse(grader.stdout.trim()) as typeof graded;
  } finally {
    cleanupTopology(topology);
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
  const { sessionId, eventLogHead } = await captureSession(dshHomeHost);
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
  const receiptPath = join(repoRoot, ".dal", "check", "e2e-receipts", `${receipt.receipt_id}.json`);
  await mkdir(join(repoRoot, ".dal", "check", "e2e-receipts"), { recursive: true, mode: 0o700 });
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
  };
}

async function main(): Promise<void> {
  const positionals = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const args = argumentsFrom(process.argv.slice(2));
  if (positionals[0] === "manifest-digest") {
    console.log(await manifestDigest(args));
    return;
  }
  const approval = args.get("approval");
  if (approval === undefined) {
    throw new Error("Usage: run-e2e.ts --approval <decision-file> [--runner docker] [--tasks a.json,b.json] [--batch <id>] [--store <dir>] [--attempts N] [--compare <summary-file>] [--faults issue_refund=unknown,...] [--resolutions issue_refund=success,...] [--generation g0|g1] [--provider <p>] [--model <m>]");
  }
  const tasks = await taskIds(args);
  const manifest = await transmissionManifest(args);
  const approvedImageDigest = requireManifestImageDigest(manifest);
  const digest = sha256(canonicalJson(manifest));
  console.error(`manifest digest: ${digest}`);
  await verifyApprovalFile(approval, { action: "send_data_externally", scope: digest, at: new Date() });
  const manifestPath = await persistTransmissionManifest(manifest, digest);

  const store = args.get("store") ?? join(repoRoot, ".dal", "runs");
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
      const { task, verdict, state, durationMs, prompt, modelPatchSha256, receiptPath, runId } = await runTask(
        args,
        taskId,
        batch,
        approvedImageDigest,
        digest,
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
              uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
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
        metrics: { duration_ms: durationMs, tool_calls: 0 },
        evidence: [`dsh-session://e2e-${task.task_id}`, `repo://${receiptPath}`],
        privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
      };
      const recordPath = join(workspace, ".dal", "benchmark", "e2e", `${runId}.json`);
      const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(recordPath, recordRaw, "utf8");
      await ingestRunRecord(recordPath, store);
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
  const summaryPath = join(repoRoot, ".dal", "check", `e2e-summary-${batch}.json`);
  await mkdir(join(repoRoot, ".dal", "check"), { recursive: true, mode: 0o700 });
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
