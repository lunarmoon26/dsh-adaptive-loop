import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deepEqual, gradeTask, GRADER_VERSION, stableJson, type WorkflowTask } from "../benchmarks/tau-style-workflow/grader/grade.js";
import { clusterRunRecords } from "../src/clustering.js";
import { runEvaluationSuite } from "../src/evaluation.js";

const workspace = resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow");
const fixture = (...parts: string[]): string => resolve(workspace, ...parts);

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(fixture(...parts), "utf8")) as T;
}

describe("tau-style workflow benchmark workspace", () => {
  it("grades a correct final state as passing", async () => {
    const task = await readJson<WorkflowTask>("tasks", "task-001-refund.json");
    const state = await readJson<unknown>("dal", "fixtures", "result-pass.json");
    const verdict = gradeTask(task, state);
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.every((check) => check.pass)).toBe(true);
    expect(verdict.grader_version).toBe(GRADER_VERSION);
  });

  it("fails a full refund that omitted the return label", async () => {
    const task = await readJson<WorkflowTask>("tasks", "task-001-refund.json");
    const state = await readJson<unknown>("dal", "fixtures", "result-fail.json");
    const verdict = gradeTask(task, state);
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.find((check) => check.id === "policy:full-refund-requires-label")?.pass).toBe(false);
  });

  it("accepts a correct policy refusal that leaves state unchanged", async () => {
    const task = await readJson<WorkflowTask>("tasks", "task-003-policy-refusal.json");
    const state = await readJson<unknown>("dal", "fixtures", "result-refusal.json");
    expect(gradeTask(task, state).pass).toBe(true);
  });

  it("grades deterministically with a stable state digest", async () => {
    const task = await readJson<WorkflowTask>("tasks", "task-001-refund.json");
    const state = await readJson<unknown>("dal", "fixtures", "result-pass.json");
    const first = gradeTask(task, state);
    const second = gradeTask(task, JSON.parse(JSON.stringify(state)));
    expect(first).toEqual(second);
    expect(stableJson(state)).toBe(stableJson(JSON.parse(JSON.stringify(state))));
    expect(deepEqual(state, JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it("evaluates the workspace suite into a passing scorecard", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-benchmark-eval-"));
    const result = await runEvaluationSuite(fixture("dal", "suite.json"), store);
    expect(result.scorecard.result).toBe("pass");
    expect(result.scorecard.metrics.task_success_rate).toBe(1);
    expect(result.scorecard.budget.external_requests).toBe(0);
  });

  it("clusters the workspace run fixtures by failure fingerprint", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-benchmark-runs-"));
    const output = await mkdtemp(join(tmpdir(), "dal-benchmark-clusters-"));
    for (const name of ["run-benchmark-pass.json", "run-benchmark-fail.json"]) {
      const source = fixture("dal", "fixtures", name);
      const copy = await readFile(source);
      await writeFile(join(store, name), copy);
    }
    const result = await clusterRunRecords({ store, output });
    expect(result.cluster_count).toBe(1);
    expect(result.skipped_successful_runs).toBe(1);
    expect(result.clusters[0]?.cluster_id.startsWith("clu-test_failure-grader-mismatch-")).toBe(true);
  });

  it("ships a workflow skill with valid frontmatter", async () => {
    const skill = await readFile(fixture(".agents", "skills", "refund-workflow", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: refund-workflow");
    expect(skill).toContain("description:");
  });

  it("ships the workspace plugin package as pinned source", async () => {
    const manifest = await readJson<{ name: string; dsh: { pluginId: string; entry: string } }>(
      ".dsh",
      "plugins",
      "dal-workflow-tools",
      "package.json",
    );
    expect(manifest.name).toBe("dal-workflow-tools");
    expect(manifest.dsh.pluginId).toBe("dal-workflow-tools");
    expect(manifest.dsh.entry).toBe("src/index.ts");
    const pluginDir = fixture(".dsh", "plugins", "dal-workflow-tools");
    expect(await readdir(pluginDir)).toEqual(expect.arrayContaining(["package.json", "README.md"]));
  });
});
