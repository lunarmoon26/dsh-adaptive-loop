/**
 * The e2e prompt contract (oracle-safe, audit P0-1): the prompt may only
 * reference the agent-visible task projection, the written policy, and the
 * workflow skill. It must never mention `goal_state` or any evaluator-only
 * content — the test suite asserts this contract.
 */
export function promptFor(taskId: string): string {
  return [
    "You are an agent completing a retail order workflow task inside the workspace /workspace/benchmarks/tau-style-workflow.",
    "",
    "Steps:",
    `1. Read the agent-visible task at /workspace/benchmarks/tau-style-workflow/.dal/benchmark/e2e/agent-task-${taskId}.json.`,
    "2. Read the written policy at /workspace/benchmarks/tau-style-workflow/tasks/policy.md and the workflow skill at /workspace/benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md. Follow them exactly.",
    "3. Starting from the task's initial_state, process the request in the instruction and write the FINAL state as JSON to /workspace/benchmarks/tau-style-workflow/.dal/benchmark/e2e/result.json, following the output conventions the workflow skill defines.",
    "4. When the file is written, respond with exactly one word: DONE",
  ].join("\n");
}
/** The headless model-patch overlay declaring the batch's model route. */
export function buildModelPatch(provider: string, model: string): string {
  return `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n`;
}
