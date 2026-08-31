import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { verifyApprovalFile } from "../../src/approval.js";
import { loadDotEnv } from "../../src/docker.js";
import { canonicalJson, sha256 } from "../../src/json.js";
import { ingestRunRecord } from "../../src/runs.js";
import { buildCompositionPatch, buildModelPatch, promptFor, providerSpec } from "./e2e-prompt.js";
import { compareGate, readSummary, type E2eSummary, type TaskSummary } from "./e2e-summary.js";
import { projectServiceState, loadState } from "./.dsh/plugins/dal-workflow-tools/src/service.js";
import { agentVisibleTask, gradeTask, GRADER_VERSION, stableJson, type WorkflowTask } from "../../src/workflow-grader.js";

/**
 * Approval-bound e2e driver for the tau-style benchmark workspace.
 *
 * Every run batch is a set of model calls: the batch manifest (model, runner,
 * task prompts) is hashed and the driver verifies an exact approved,
 * unexpired send_data_externally decision against that digest before the
 * first call. Tasks run through `dsh --profile headless` (local or in the
 * pinned container), each final state is graded with the deterministic
 * grader, and one immutable run record per task is ingested into the run
 * store. The driver performs no optimization and applies nothing.
 */

const workspace = resolve(import.meta.dirname);
const repoRoot = resolve(workspace, "..", "..");
const DEFAULT_IMAGE = "dsh-adaptive-loop/dsh:0.1.1-rc.2-demo";

interface RunTask {
  task_id: string;
  prompt: string;
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
  return result.stdout.trim().split("\n").at(-1) ?? null;
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
async function manifestDigest(args: Map<string, string>): Promise<string> {
  const tasks = await taskIds(args);
  const runner = args.get("runner") ?? "docker";
  const provider = args.get("provider") ?? "deepseek-official";
  const model = args.get("model") ?? "deepseek-v4-flash";
  const loadTask = async (taskId: string): Promise<WorkflowTask> =>
    JSON.parse(await readFile(join(workspace, "tasks", taskId), "utf8")) as WorkflowTask;
  const agentTasks: { task_id: string; sha256: string }[] = [];
  for (const taskId of tasks) {
    agentTasks.push({ task_id: taskId, sha256: sha256(stableJson(agentVisibleTask(await loadTask(taskId)))) });
  }
  const manifest = {
    purpose: "tau-style-workflow e2e run batch",
    provider,
    model,
    runner,
    faults: args.get("faults") ?? null,
    resolutions: args.get("resolutions") ?? null,
    container_image_sha256: runner === "docker" ? await containerImageDigest() : null,
    policy_sha256: sha256(await readFile(join(workspace, "tasks", "policy.md"), "utf8")),
    skill_sha256: sha256(await readFile(join(workspace, ".agents", "skills", "refund-workflow", "SKILL.md"), "utf8")),
    workflow_tools_sha256:
      runner === "docker"
        ? await containerDirDigest(DEFAULT_IMAGE, "/opt/dal/plugins/dal-workflow-tools")
        : await dirDigest(join(workspace, ".dsh", "plugins", "dal-workflow-tools")),
    agent_tasks: agentTasks,
    prompts: tasks.map((taskId) => ({ task_id: taskId, prompt: promptFor(taskId) })),
  };
  return sha256(canonicalJson(manifest));
}

async function taskIds(args: Map<string, string>): Promise<string[]> {
  const selected = args.get("tasks");
  const files = (await readdir(join(workspace, "tasks"))).filter((name) => name.endsWith(".json")).sort();
  if (selected === undefined) {
    return files;
  }
  const wanted = new Set(selected.split(","));
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

/** Remove lingering containers of the demo image left by a timed-out client. */
function killLingeringContainers(): void {
  const list = spawnSync("docker", ["ps", "--filter", `ancestor=${DEFAULT_IMAGE}`, "--format", "{{.ID}}"], { encoding: "utf8", timeout: 15_000 });
  for (const id of list.stdout.trim().split("\n").filter((line) => line !== "")) {
    spawnSync("docker", ["rm", "-f", id], { timeout: 30_000 });
  }
}

async function runTask(
  args: Map<string, string>,
  taskId: string,
  batch: string,
): Promise<{ task: WorkflowTask; verdict: ReturnType<typeof gradeTask>; state: unknown; durationMs: number; prompt: string; modelPatchSha256: string; receiptPath: string }> {
  const task = JSON.parse(await readFile(join(workspace, "tasks", taskId), "utf8")) as WorkflowTask;
  const prompt = promptFor(taskId);
  await mkdir(join(workspace, ".dal", "benchmark", "e2e"), { recursive: true, mode: 0o700 });
  const agentTaskPath = join(workspace, ".dal", "benchmark", "e2e", `agent-task-${taskId}.json`);
  await writeFile(agentTaskPath, `${JSON.stringify(agentVisibleTask(task), null, 2)}\n`, "utf8");

  const provider = args.get("provider") ?? "deepseek-official";
  const model = args.get("model") ?? "deepseek-v4-flash";
  const faults: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">> = {};
  const rawFaults = args.get("faults");
  if (rawFaults !== undefined) {
    for (const pair of rawFaults.split(",")) {
      const [kind, outcome] = pair.split("=");
      if (kind !== undefined && (outcome === "success" || outcome === "definite_failure" || outcome === "unknown")) {
        faults[kind as keyof typeof faults] = outcome;
      }
    }
  }
  const resolutions: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure">> = {};
  const rawResolutions = args.get("resolutions");
  if (rawResolutions !== undefined) {
    for (const pair of rawResolutions.split(",")) {
      const [kind, outcome] = pair.split("=");
      if (kind !== undefined && (outcome === "success" || outcome === "definite_failure")) {
        resolutions[kind as keyof typeof resolutions] = outcome;
      }
    }
  }
  const stateRootHost = join(workspace, SERVICE_ROOT, batch);
  await mkdir(stateRootHost, { recursive: true, mode: 0o700 });
  const seedState = { orders: (task.initial_state.orders ?? {}) as Record<string, unknown>, refunds: (task.initial_state.refunds ?? []) as unknown[], labels: (task.initial_state.labels ?? []) as unknown[], bookings: (task.initial_state.bookings ?? {}) as Record<string, unknown> };
  const resetServiceState = async (): Promise<void> => {
    await writeFile(join(stateRootHost, "state.json"), `${JSON.stringify(seedState, null, 2)}\n`, "utf8");
    await writeFile(join(stateRootHost, "effects.jsonl"), "", "utf8");
  };
  await resetServiceState();
  const beforeDigest = sha256(JSON.stringify(seedState));

  const containerStateRoot = `/workspace/benchmarks/tau-style-workflow/.dal/benchmark/service/${batch}`;
  const modelPatch = buildModelPatch(provider, model);
  const compositionPatch = buildCompositionPatch(provider, model, containerStateRoot, faults, resolutions);
  const patchPath = join(workspace, ".dal", "benchmark", "e2e", "model-patch.yml");
  await writeFile(patchPath, compositionPatch, "utf8");
  const containerPatch = "/workspace/benchmarks/tau-style-workflow/.dal/benchmark/e2e/model-patch.yml";

  const keyEnv = providerSpec(provider).apiKeyEnv;
  const key = process.env[keyEnv] ?? loadDotEnv(repoRoot)[keyEnv] ?? "";
  if (key === "") {
    throw new Error(`Provider "${provider}" needs ${keyEnv}; set it in the environment or ${repoRoot}/.env before running`);
  }

  const dshHomeHost = join(workspace, ".dal", "benchmark", "e2e", "dsh-home");
  await mkdir(dshHomeHost, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const runner = args.get("runner") ?? "docker";
  let result;
  if (runner === "docker") {
    const argv = [
      "run",
      "--rm",
      "-v",
      `${repoRoot}:/workspace`,
      "-v",
      `${dshHomeHost}:/tmp/dsh-home`,
      "-e",
      "DSH_HOME=/tmp/dsh-home",
      "-w",
      "/workspace/benchmarks/tau-style-workflow",
      "-e",
      `${keyEnv}=${key}`,
      DEFAULT_IMAGE,
      "dsh",
      "--profile",
      "headless",
      "--patch",
      containerPatch,
      prompt,
    ];
    await ensureDocker();
    for (let attempt = 0; ; attempt += 1) {
      result = spawnSync("docker", argv, { encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
      if (result.error === undefined || attempt >= 1) {
        break;
      }
      // Transport failure (timed-out or dead daemon): kill any container the
      // killed client left behind, reseed the service state, and retry once.
      console.error(`docker transport failure for ${taskId}: ${result.error.message}; cleaning up and retrying once`);
      killLingeringContainers();
      await resetServiceState();
      await ensureDocker();
    }
  } else {
    result = spawnSync("dsh", ["--profile", "headless", "--patch", patchPath, prompt], {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: dshHomeHost },
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  const durationMs = Date.now() - started;
  if (result.error !== undefined) {
    throw new Error(`dsh headless failed to start for ${taskId}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`dsh headless exited ${result.status} for ${taskId}: ${String(result.stderr).slice(-500)}`);
  }

  const serviceState = await loadState({ stateRoot: stateRootHost, faults: {} });
  const state = projectServiceState(serviceState);
  const verdict = gradeTask(task, state);
  const afterDigest = sha256(stableJson(state));
  const effectLog = await readFile(join(stateRootHost, "effects.jsonl"), "utf8");
  const skillDigest = sha256(await readFile(join(workspace, ".agents", "skills", "refund-workflow", "SKILL.md"), "utf8"));
  const { sessionId, eventLogHead } = await captureSession(dshHomeHost);
  const imageDigest = runner === "docker" ? await containerImageDigest() : null;
  const toolsDigest =
    runner === "docker"
      ? await containerDirDigest(DEFAULT_IMAGE, "/opt/dal/plugins/dal-workflow-tools")
      : await dirDigest(join(workspace, ".dsh", "plugins", "dal-workflow-tools"));
  const compositionDigest = sha256(
    canonicalJson({
      patch: compositionPatch,
      skill: skillDigest,
      workflow_tools: toolsDigest,
      container_image: imageDigest,
    }),
  );
  const generation = args.get("generation");
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: `rcp-${task.task_id}-${randomUUID().slice(0, 8)}`,
    created_at: new Date().toISOString(),
    candidate_sha256: skillDigest,
    base_generation_id: generation ?? (batch === "baseline" ? "g0" : "g1"),
    candidate_generation_id: generation ?? (batch === "baseline" ? "g0" : "g1"),
    effective_composition_sha256: compositionDigest,
    task_handle: task.task_id,
    model: { provider, model },
    model_patch_sha256: sha256(modelPatch),
    dsh_session_id: sessionId,
    event_log_head_sha256: eventLogHead,
    business_effect_log_head_sha256: effectLog.trim() === "" ? null : sha256(effectLog.trim()),
    container_image_sha256: imageDigest,
    external_state_before_sha256: beforeDigest,
    external_state_after_sha256: afterDigest,
    grader_receipt_sha256: sha256(stableJson(verdict)),
    source: "repo://benchmarks/tau-style-workflow/run-e2e.ts",
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
    receiptPath: relative(process.cwd(), receiptPath),
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
    throw new Error("Usage: run-e2e.ts --approval <decision-file> [--runner docker|local] [--tasks a.json,b.json] [--batch <id>] [--store <dir>] [--attempts N] [--compare <summary-file>] [--faults issue_refund=unknown,...] [--resolutions issue_refund=success,...] [--generation g0|g1|g2] [--provider <p>] [--model <m>]");
  }
  const tasks = await taskIds(args);
  const digest = await manifestDigest(args);
  console.error(`manifest digest: ${digest}`);
  await verifyApprovalFile(approval, { action: "send_data_externally", scope: digest, at: new Date() });

  const store = args.get("store") ?? join(repoRoot, ".dal", "runs");
  const batch = args.get("batch") ?? "baseline";
  const skillDigest = sha256(await readFile(join(workspace, ".agents", "skills", "refund-workflow", "SKILL.md"), "utf8"));
  const goalDigest = (task: WorkflowTask): string => sha256(stableJson(task.goal_state));
  const model = args.get("model") ?? "deepseek-v4-flash";
  const provider = args.get("provider") ?? "deepseek-official";
  const attemptsRaw = args.get("attempts");
  const attemptsPerTask = attemptsRaw === undefined ? 1 : Number.parseInt(attemptsRaw, 10);
  if (!Number.isInteger(attemptsPerTask) || attemptsPerTask < 1) {
    throw new Error("--attempts must be a positive integer");
  }
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
      const { task, verdict, state, durationMs, prompt, modelPatchSha256, receiptPath } = await runTask(args, taskId, batch);
      const passed = verdict.pass;
      if (!passed) {
        failed += 1;
      } else {
        taskSummary.passed += 1;
      }
      if (attempt === 1 && passed) {
        taskSummary.pass_at_1 = true;
      }
      const failedChecks = verdict.checks.filter((check) => !check.pass);
      const runId = `run-e2e-${task.task_id}-${batch}-${randomUUID().slice(0, 8)}`;
      const record = {
        $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
        schema_version: "1.0.0",
        run_id: runId,
        task_id: task.task_id,
        change_id: `chg-e2e-${batch}`,
        started_at: new Date(Date.now() - durationMs).toISOString(),
        finished_at: new Date().toISOString(),
        outcome: passed ? "succeeded" : "failed",
        failure:
          failedChecks.length === 0
            ? null
            : {
                category: "test_failure",
                code: `check-${failedChecks[0]!.id.replaceAll(/[^a-z0-9._-]/gi, "-").toLowerCase() || "unknown"}`,
                fingerprint_extra: failedChecks.map((check) => check.id),
                summary: failedChecks.map((check) => check.summary || `check ${check.id}`).join("; ").slice(0, 8192),
                evidence: ["repo://benchmarks/tau-style-workflow/grader/grade.ts"],
              },
        context: {
          task_set: "tau-style-workflow-e2e",
          environment_snapshot: `${process.platform} ${process.arch} node ${process.versions.node}`,
          tool_versions: [],
          model: { id: model, version: provider },
          prompt_sha256: sha256(prompt),
          harness_sha256: null,
          grader_version: "1.0.0",
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
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await ingestRunRecord(recordPath, store);
      const receiptAbsolute = resolve(process.cwd(), receiptPath);
      const receiptRaw = await readFile(receiptAbsolute);
      taskSummary.attempts_detail.push({
        attempt,
        run_id: runId,
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

  const outcomes = perTask.flatMap((task) => task.attempts_detail.map((detail) => (detail.passed ? 1 : 0)));
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

await main();
