import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { assessDevelopmentBaseline, compareSkillAdaptation, FAULT_PROFILES, PARTITIONS, type Partition } from "../benchmarks/tau-style-workflow/skill-adaptation.js";
import { compareGate, type E2eSummary } from "../benchmarks/tau-style-workflow/e2e-summary.js";
import { canonicalJson, sha256 } from "../src/json.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "dal-synthetic-adaptation-"));
  roots.push(root);
  return root;
}

// Digest-bound synthetic evidence, deliberately declaring live solely to exercise
// the real validator. No harness, provider, or measured model improvement exists.
async function fixture(root: string, generation: "g0" | "g1", outcomes: boolean[], options: {
  partition?: Partition; mode?: string; tasks?: string[]; model?: string;
  context?: string; candidate?: string; faults?: string; resolutions?: string;
} = {}) {
  const partition = options.partition ?? "held-out";
  const tasks = options.tasks ?? [...PARTITIONS[partition]];
  const candidate = options.candidate ?? sha256(`synthetic skill ${generation}`);
  const model = { provider: "openai", model: options.model ?? "synthetic-validator-model" };
  const manifest = {
    mode: options.mode ?? "live", provider: model.provider, model: model.model, generation,
    attempts_per_task: 1, runner: "docker",
    faults: options.faults ?? FAULT_PROFILES[partition].faults,
    resolutions: options.resolutions ?? FAULT_PROFILES[partition].resolutions,
    skill_sha256: candidate, benchmark_context_sha256: options.context ?? "b".repeat(64),
    container_image_sha256: "3".repeat(64),
    evaluator_tasks: tasks.map(task_id => ({ task_id, sha256: sha256(task_id) })),
  };
  const manifestPath = `${generation}-manifest.json`;
  await writeFile(join(root, manifestPath), JSON.stringify(manifest));
  const manifestDigest = sha256(canonicalJson(manifest));
  const perTask: E2eSummary["per_task"] = [];
  for (const [index, task] of tasks.entries()) {
    const passed = outcomes[index] ?? false;
    const runId = `run-synthetic-${generation}-${index}`;
    const receiptPath = `${generation}-${index}-receipt.json`;
    const runPath = `${generation}-${index}-run.json`;
    const source = "repo://tests/skill-adaptation.test.ts";
    const business = { status: passed ? "passed" : "failed", source, score: Number(passed), earned: Number(passed), total: 1 };
    const receipt = {
      $schema: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
      schema_version: "1.0.0", receipt_id: `rcp-synthetic-${generation}-${index}`, run_id: runId,
      created_at: "2026-09-10T00:00:00.000Z", candidate_sha256: candidate,
      base_generation_id: "g0", candidate_generation_id: generation,
      effective_composition_sha256: "d".repeat(64), task_handle: task, model,
      model_patch_sha256: "e".repeat(64), dsh_session_id: null, event_log_head_sha256: null,
      container_image_sha256: manifest.container_image_sha256, transmission_manifest_sha256: manifestDigest,
      external_state_before_sha256: "0".repeat(64), external_state_after_sha256: "a".repeat(64),
      grader_receipt_sha256: "1".repeat(64), source,
      isolation: { topology: "candidate-service-grader-v1", candidate_workspace_sha256: "2".repeat(64),
        candidate_workspace_read_only: true, candidate_repository_mounted: false,
        service_state_access: "typed-endpoint-only", oracle_access: "grader-only" },
      business_outcome: business,
    };
    const run = {
      $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json", schema_version: "1.0.0",
      run_id: runId, task_id: task, change_id: "chg-dal-skill-adaptation-slice-20260910",
      started_at: "2026-09-10T00:00:00.000Z", finished_at: "2026-09-10T00:01:00.000Z",
      outcome: "succeeded", failure: null,
      context: { task_set: "tau-style-workflow-e2e", environment_snapshot: "synthetic validator fixture only",
        tool_versions: [], model: { id: model.model, version: model.provider }, prompt_sha256: null,
        harness_sha256: null, grader_version: "2.0.0", seeds: [], context_policy_sha256: null,
        inference_parameters: [], harness_pins: [{ surface: "skills", uri: "repo://synthetic-skill", sha256: candidate }] },
      artifacts: [], checks: passed ? [] : [{ id: "business-verdict", pass: false, detail: "Synthetic business failure",
        goal_sha256: "7".repeat(64), actual_sha256: "a".repeat(64) }],
      business_outcome: business, metrics: { duration_ms: 1, tool_calls: 0 },
      evidence: [`repo://${receiptPath}`], privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
    };
    const receiptRaw = JSON.stringify(receipt);
    const runRaw = JSON.stringify(run);
    await writeFile(join(root, receiptPath), receiptRaw);
    await writeFile(join(root, runPath), runRaw);
    perTask.push({ task_id: task, attempts: 1, passed: Number(passed), mean: Number(passed),
      pass_at_1: passed, checkpoint_pass: passed,
      attempts_detail: [{ attempt: 1, run_id: runId, run_record_path: runPath, run_record_sha256: sha256(runRaw),
        receipt_path: receiptPath, receipt_sha256: sha256(receiptRaw), state_sha256: "a".repeat(64), passed }] });
  }
  const mean = perTask.reduce((sum, task) => sum + task.mean, 0) / perTask.length;
  const summary: E2eSummary = {
    format: "e2e-summary-v1", summary_id: `esm-synthetic-${generation}`, created_at: "2026-09-10T00:02:00.000Z",
    batch: `synthetic-${generation}`, task_set: tasks, model, generation, candidate_sha256: candidate,
    benchmark_context_sha256: manifest.benchmark_context_sha256, transmission_manifest_path: manifestPath,
    transmission_manifest_sha256: manifestDigest, runner: "docker", faults: manifest.faults, resolutions: manifest.resolutions,
    attempts_per_task: 1, per_task: perTask,
    overall: { mean_success_rate: mean, pass_at_1: mean, checkpoint_rate: mean, variance: mean - mean * mean },
  };
  const path = join(root, `${generation}-summary.json`);
  await writeFile(path, JSON.stringify(summary));
  return { path, summary };
}

describe("skill adaptation (synthetic validator evidence, not real improvement)", () => {
  it("reports positive gain only after the actual gate, with separate transfer/regression deltas and actual references", async () => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false, true, true, true]);
    const candidate = await fixture(root, "g1", [true, true, true, true]);
    expect(await compareGate(candidate.summary, baseline.summary, root)).toMatchObject({ pass: true });
    const report = await compareSkillAdaptation(candidate.path, baseline.path, root);
    expect(report).toMatchObject({ status: "improved", mean_delta: 0.25,
      partition_deltas: { transfer: 0.5, regression: 0 }, promotion_authorized: false,
      improvement_scope: "evaluated_cases", evaluated_cases: PARTITIONS["held-out"] });
    expect(report.evidence).toHaveLength(2);
    expect(report.evidence[1]?.attempts[0]).toMatchObject({ receipt_path: "g1-0-receipt.json", source: "repo://tests/skill-adaptation.test.ts" });
    expect(report.limited_claim).toContain("Synthetic validator fixtures are not model improvement");
  });

  it("reports equality as no improvement", async () => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [true, true, true, true]);
    const candidate = await fixture(root, "g1", [true, true, true, true]);
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root)).toMatchObject({ status: "no_improvement", mean_delta: 0 });
  });

  it("does not turn tolerated numeric rounding into improvement", async () => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false, true, true, true]);
    const candidate = await fixture(root, "g1", [false, true, true, true]);
    candidate.summary.overall.mean_success_rate += 1e-10;
    await writeFile(candidate.path, JSON.stringify(candidate.summary));
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root)).toMatchObject({ status: "no_improvement", mean_delta: 0 });
  });

  it("rejects two equally incomplete held-out batches even when the existing gate passes", async () => {
    const root = await directory();
    const tasks = [...PARTITIONS["held-out"]].slice(0, 2);
    const baseline = await fixture(root, "g0", [false, true], { tasks });
    const candidate = await fixture(root, "g1", [true, true], { tasks });
    expect(await compareGate(candidate.summary, baseline.summary, root)).toMatchObject({ pass: true });
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root)).toMatchObject({ status: "rejected" });
  });

  it.each([
    { tasks: ["task-001-refund.json"] },
    { faults: "issue_refund=definite_failure" },
    { resolutions: "issue_refund=definite_failure" },
  ])("does not enroll the wrong development experiment: %j", async options => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false], { partition: "development", ...options });
    expect(await assessDevelopmentBaseline(baseline.path, root)).toMatchObject({ status: "rejected", eligible: false });
  });

  it("rejects a regression even with positive aggregate gain", async () => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false, false, true, true]);
    const candidate = await fixture(root, "g1", [true, true, false, true]);
    const report = await compareSkillAdaptation(candidate.path, baseline.path, root);
    expect(report.status).toBe("rejected");
    expect(report.problems.join(" ")).toContain("regressed tasks");
    expect(report.mean_delta).toBeUndefined();
    expect(report.evaluated_cases).toEqual([]);
  });

  it.each([true, false])("assesses a verified development baseline with business pass=%s", async passed => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [passed], { partition: "development" });
    expect(await assessDevelopmentBaseline(baseline.path, root)).toMatchObject({
      status: passed ? "no_change_needed" : "eligible_for_proposal", eligible: !passed,
      evaluated_cases: PARTITIONS.development, promotion_authorized: false,
    });
    expect((await assessDevelopmentBaseline(baseline.path, root)).limited_claim).toContain("not two trials");
  });

  it("supports the development comparison without implying held-out gain", async () => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false], { partition: "development" });
    const candidate = await fixture(root, "g1", [true], { partition: "development" });
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root, "development")).toMatchObject({
      status: "improved", evaluated_cases: PARTITIONS.development, partition_deltas: { development: 1 },
    });
  });

  it.each(["rehearsal", "synthetic", ""])("refuses bound mode %s in baseline and comparison", async mode => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false], { partition: "development", mode });
    const candidate = await fixture(root, "g1", [true], { partition: "development" });
    expect(await assessDevelopmentBaseline(baseline.path, root)).toMatchObject({ status: "rejected", eligible: false });
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root, "development")).toMatchObject({ status: "rejected" });
    await fixture(root, "g0", [false], { partition: "development" });
    await fixture(root, "g1", [true], { partition: "development", mode });
    expect(await compareSkillAdaptation(candidate.path, baseline.path, root, "development")).toMatchObject({ status: "rejected" });
  });

  it.each([
    { tasks: [...PARTITIONS["held-out"]].slice(0, 2) },
    { model: "changed-model" }, { context: "c".repeat(64) },
    { faults: "issue_refund=unknown" }, { resolutions: "issue_refund=definite_failure" },
    { candidate: sha256("synthetic skill g0") },
  ])("rejects missing cases, confounds, wrong profiles or identical candidates: %j", async options => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false, true, true, true]);
    const candidate = await fixture(root, "g1", [true, true, true, true], options);
    const report = await compareSkillAdaptation(candidate.path, baseline.path, root);
    expect(report.status).toBe("rejected");
    expect(report.mean_delta).toBeUndefined();
    expect(report.evidence).toEqual([]);
  });

  it.each(["receipt", "manifest", "run", "metrics", "state", "generation"])("rejects tampered %s evidence", async kind => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false, true, true, true]);
    const candidate = await fixture(root, "g1", [true, true, true, true]);
    if (kind === "metrics") candidate.summary.overall.mean_success_rate = 0.9;
    else if (kind === "state") candidate.summary.per_task[0]!.attempts_detail[0]!.state_sha256 = "f".repeat(64);
    else if (kind === "generation") candidate.summary.generation = "g0";
    else {
      const path = join(root, kind === "manifest" ? "g1-manifest.json" : `g1-0-${kind}.json`);
      await writeFile(path, `${await readFile(path, "utf8")} `);
      // Manifest digests use canonical JSON, so alter a value rather than whitespace.
      if (kind === "manifest") await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), mode: "rehearsal" }));
    }
    await writeFile(candidate.path, JSON.stringify(candidate.summary));
    const report = await compareSkillAdaptation(candidate.path, baseline.path, root);
    expect(report.status).toBe("rejected");
    expect(report.mean_delta).toBeUndefined();
  });

  it("rejects malformed summaries without exposing their raw contents", async () => {
    const root = await directory();
    const path = join(root, "bad.json");
    await writeFile(path, "not-json-private-content");
    const report = await assessDevelopmentBaseline(path, root);
    expect(report.status).toBe("rejected");
    expect(JSON.stringify(report)).not.toContain("not-json-private-content");
  });

  it.each(["missing", "tampered"])("does not enroll baseline business failure with %s receipt", async damage => {
    const root = await directory();
    const baseline = await fixture(root, "g0", [false], { partition: "development" });
    const path = join(root, "g0-0-receipt.json");
    if (damage === "missing") await rm(path);
    else await writeFile(path, `${await readFile(path, "utf8")} `);
    expect(await assessDevelopmentBaseline(baseline.path, root)).toMatchObject({
      status: "rejected", eligible: false, evidence: [], evaluated_cases: [],
    });
  });

  it("CLI emits structured stdout, writes only explicit output, and refuses output conflicts", async () => {
    const root = await directory();
    const bad = join(root, "missing.json");
    const output = join(root, "report.json");
    const run = async (args: string[]) => {
      try {
        return await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("benchmarks/tau-style-workflow/skill-adaptation.ts"), ...args]);
      } catch (error) { return error as { stdout: string; stderr: string }; }
    };
    expect(JSON.parse((await run(["--baseline", bad])).stdout).status).toBe("rejected");
    await run(["--baseline", bad, "--output", output]);
    const before = await readFile(output, "utf8");
    expect(JSON.parse(before).status).toBe("rejected");
    expect(JSON.parse((await run(["--baseline", bad, "--output", output])).stdout).status).toBe("error");
    expect(await readFile(output, "utf8")).toBe(before);
    expect(JSON.parse((await run(["--baseline", bad, "--partition", "other"])).stdout).status).toBe("error");
  });
});
