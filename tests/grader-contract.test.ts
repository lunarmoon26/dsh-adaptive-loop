import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { aggregate, gradeTask, type WorkflowTask } from "../src/workflow-grader.js";

const workspace = resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow");
const readTask = async (name: string): Promise<WorkflowTask> =>
  JSON.parse(await readFile(resolve(workspace, "tasks", name), "utf8")) as WorkflowTask;
const readState = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(workspace, "dal", "fixtures", name), "utf8")) as unknown;

describe("weighted and gated grader contract", () => {
  it("reports partial credit for a passing-but-imperfect state", async () => {
    const task = await readTask("task-001-refund.json");
    const state = await readState("result-fail.json");
    const verdict = gradeTask(task, state);
    expect(verdict.pass).toBe(false);
    expect(verdict.score).toBeLessThan(1);
    expect(verdict.score).toBe(verdict.earned / verdict.total);
    expect(verdict.total).toBeGreaterThan(0);
  });

  it("reports a perfect score with all checks weighted equally", async () => {
    const task = await readTask("task-001-refund.json");
    const state = await readState("result-pass.json");
    const verdict = gradeTask(task, state);
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBe(1);
    expect(verdict.earned).toBe(verdict.total);
  });

  it("gates dependent policy checks on a failed goal:refunds check", async () => {
    const task = await readTask("task-001-refund.json");
    const state = {
      orders: { "o-1001": { status: "refunded" } },
      refunds: [{ order: "o-1001", amount: 150, reason: "damaged" }],
      labels: [],
    };
    const verdict = gradeTask(task, state);
    const goalRefunds = verdict.checks.find((check) => check.id === "goal:refunds");
    expect(goalRefunds?.pass).toBe(false);
    const exceeds = verdict.checks.find((check) => check.id === "policy:refund-exceeds-total");
    expect(exceeds).toBeDefined();
    expect(exceeds?.gated).toEqual({ reason: "refund amount exceeds the order total", upstream: "goal:refunds" });
    // Gated checks are excluded from the credit totals: only the goal checks count.
    expect(verdict.total).toBe(Object.keys(task.goal_state).length);
  });

  it("aggregates weights and skips gated checks", () => {
    const result = aggregate([
      { id: "a", pass: true, detail: "", weight: 4 },
      { id: "b", pass: false, detail: "", weight: 3 },
      { id: "c", pass: false, detail: "", gated: { reason: "upstream failed", upstream: "b" } },
      { id: "d", pass: true, detail: "" },
    ]);
    expect(result).toEqual({ score: 5 / 8, earned: 5, total: 8 });
  });
});
