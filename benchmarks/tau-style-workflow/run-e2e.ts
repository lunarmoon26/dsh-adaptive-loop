import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { verifyApprovalFile } from "../../src/approval.js";
import { loadDotEnv } from "../../src/docker.js";
import { canonicalJson, sha256 } from "../../src/json.js";
import { ingestRunRecord } from "../../src/runs.js";
import { buildCompositionPatch, buildModelPatch, promptFor } from "./e2e-prompt.js";
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


async function manifestDigest(args: Map<string, string>): Promise<string> {
  const tasks = await taskIds(args);
  const manifest = {
    purpose: "tau-style-workflow e2e run batch",
    model: args.get("model") ?? "deepseek-v4-flash",
    runner: args.get("runner") ?? "docker",
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
  const stateRootHost = join(workspace, SERVICE_ROOT);
  await mkdir(stateRootHost, { recursive: true, mode: 0o700 });
  const seedState = { orders: (task.initial_state.orders ?? {}) as Record<string, unknown>, refunds: (task.initial_state.refunds ?? []) as unknown[], labels: (task.initial_state.labels ?? []) as unknown[], bookings: (task.initial_state.bookings ?? {}) as Record<string, unknown> };
  await writeFile(join(stateRootHost, "state.json"), `${JSON.stringify(seedState, null, 2)}\n`, "utf8");
  await writeFile(join(stateRootHost, "effects.jsonl"), "", "utf8");
  const beforeDigest = sha256(JSON.stringify(seedState));

  const containerStateRoot = "/workspace/benchmarks/tau-style-workflow/.dal/benchmark/service";
  const modelPatch = buildModelPatch(provider, model);
  const compositionPatch = buildCompositionPatch(provider, model, containerStateRoot, faults);
  const patchPath = join(workspace, ".dal", "benchmark", "e2e", "model-patch.yml");
  await writeFile(patchPath, compositionPatch, "utf8");
  const containerPatch = "/workspace/benchmarks/tau-style-workflow/.dal/benchmark/e2e/model-patch.yml";

  const started = Date.now();
  const runner = args.get("runner") ?? "docker";
  let result;
  if (runner === "docker") {
    const key = process.env.DEEPSEEK_API_KEY ?? loadDotEnv(repoRoot).DEEPSEEK_API_KEY ?? "";
    const argv = [
      "run",
      "--rm",
      "-v",
      `${repoRoot}:/workspace`,
      "-w",
      "/workspace/benchmarks/tau-style-workflow",
      ...(key === "" ? [] : ["-e", `DEEPSEEK_API_KEY=${key}`]),
      DEFAULT_IMAGE,
      "dsh",
      "--profile",
      "headless",
      "--patch",
      containerPatch,
      prompt,
    ];
    result = spawnSync("docker", argv, { encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  } else {
    result = spawnSync("dsh", ["--profile", "headless", "--patch", patchPath, prompt], {
      cwd: workspace,
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
  const compositionDigest = sha256(`${compositionPatch}|${skillDigest}`);
  const receipt = {
    $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
    schema_version: "1.0.0",
    receipt_id: `rcp-${task.task_id}-${randomUUID().slice(0, 8)}`,
    created_at: new Date().toISOString(),
    candidate_sha256: skillDigest,
    base_generation_id: batch === "baseline" ? "g0" : "g1",
    candidate_generation_id: batch === "baseline" ? "g0" : "g1",
    effective_composition_sha256: compositionDigest,
    task_handle: task.task_id,
    model: { provider, model },
    model_patch_sha256: sha256(modelPatch),
    dsh_session_id: null,
    event_log_head_sha256: effectLog.trim() === "" ? null : sha256(effectLog.trim()),
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
    throw new Error("Usage: run-e2e.ts --approval <decision-file> [--runner docker|local] [--tasks a.json,b.json] [--batch <id>] [--store <dir>]");
  }
  const tasks = await taskIds(args);
  const digest = await manifestDigest(args);
  await verifyApprovalFile(approval, { action: "send_data_externally", scope: digest, at: new Date() });

  const store = args.get("store") ?? join(repoRoot, ".dal", "runs");
  const batch = args.get("batch") ?? "baseline";
  const skillDigest = sha256(await readFile(join(workspace, ".agents", "skills", "refund-workflow", "SKILL.md"), "utf8"));
  const goalDigest = (task: WorkflowTask): string => sha256(stableJson(task.goal_state));
  const model = args.get("model") ?? "deepseek-v4-flash";
  const provider = args.get("provider") ?? "deepseek-official";
  let failed = 0;
  for (const taskId of tasks) {
    const { task, verdict, state, durationMs, prompt, modelPatchSha256, receiptPath } = await runTask(args, taskId, batch);
    const passed = verdict.pass;
    if (!passed) {
      failed += 1;
    }
    const failedChecks = verdict.checks.filter((check) => !check.pass);
    const record = {
      $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
      schema_version: "1.0.0",
      run_id: `run-e2e-${task.task_id}-${batch}-${randomUUID().slice(0, 8)}`,
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
    const recordPath = join(workspace, ".dal", "benchmark", "e2e", `${record.run_id}.json`);
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await ingestRunRecord(recordPath, store);
    const checks = verdict.checks.map((check) => `${check.pass ? "ok" : "FAIL"}:${check.id}`).join(" ");
    console.log(`${task.task_id}\t${passed ? "passed" : "failed"}\t${checks}`);
  }
  const total = tasks.length;
  console.log(`summary\t${total - failed}/${total} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
