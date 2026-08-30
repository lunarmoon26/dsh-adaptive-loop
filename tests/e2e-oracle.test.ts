import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { promptFor } from "../benchmarks/tau-style-workflow/e2e-prompt.js";
import { agentVisibleTask, type WorkflowTask } from "../src/workflow-grader.js";

const workspace = resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow");

describe("oracle isolation (audit P0-1)", () => {
  it("keeps goal_state and policy_ref out of the agent-visible projection", async () => {
    const task = JSON.parse(
      await readFile(resolve(workspace, "tasks", "task-001-refund.json"), "utf8"),
    ) as WorkflowTask;
    const visible = agentVisibleTask(task);
    expect(visible).toEqual({
      task_id: task.task_id,
      domain: task.domain,
      instruction: task.instruction,
      initial_state: task.initial_state,
    });
    expect(JSON.stringify(visible)).not.toContain("goal_state");
    expect(JSON.stringify(visible)).not.toContain("policy_ref");
  });

  it("keeps the e2e prompt free of evaluator-only references", () => {
    for (const taskId of [
      "task-001-refund.json",
      "task-002-booking-change.json",
      "task-003-policy-refusal.json",
      "task-004-partial-refund.json",
      "task-005-booking-refusal.json",
    ]) {
      const prompt = promptFor(taskId);
      expect(prompt).toContain("agent-visible task");
      expect(prompt).not.toContain("goal_state");
      // The written policy is agent-visible; the oracle-bearing task file is not.
      expect(prompt).not.toContain(`tasks/${taskId}`);
      expect(prompt).toContain("tasks/policy.md");
    }
  });

  it("keeps the workflow skill free of oracle references", async () => {
    const skill = await readFile(
      resolve(workspace, ".agents", "skills", "refund-workflow", "SKILL.md"),
      "utf8",
    );
    expect(skill).not.toContain("goal_state");
    expect(skill).toContain("output convention");
  });
});
