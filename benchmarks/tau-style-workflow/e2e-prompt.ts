/**
 * The e2e prompt contract (oracle-safe, audit P0-1): the prompt may only
 * reference the agent-visible task projection, the written policy, and the
 * workflow skill. It must never mention `goal_state` or any evaluator-only
 * content — the test suite asserts this contract. The agent operates the
 * mock service exclusively through the typed workflow tools.
 */
export function promptFor(taskId: string): string {
  return [
    "You are an agent completing a retail order workflow task inside the workspace /workspace/benchmarks/tau-style-workflow.",
    "",
    "Steps:",
    `1. Read the agent-visible task at /workspace/benchmarks/tau-style-workflow/.dal/benchmark/e2e/agent-task-${taskId}.json.`,
    "2. Read the written policy at /workspace/benchmarks/tau-style-workflow/tasks/policy.md and the workflow skill at /workspace/benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md. Follow them exactly.",
    "3. Operate the mock order/booking service ONLY through the typed tools (get_order, get_booking, issue_refund, create_return_label, change_booking, refuse_request, get_effect_status). Never write result files yourself.",
    "4. When the workflow is complete, respond with exactly one word: DONE",
  ].join("\n");
}

/** The headless model-patch overlay declaring the batch's model route. */
export function buildModelPatch(provider: string, model: string): string {
  return `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n`;
}

/** The tools row mounting the mock-service workflow tools in the container. */
export function buildToolsRow(
  stateRoot: string,
  faults: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">> = {},
): string {
  const faultLines = Object.entries(faults)
    .map(([kind, outcome]) => `      ${kind}: ${outcome}`)
    .join("\n");
  const faultBlock = faultLines === "" ? "" : `\n    faults:\n${faultLines}`;
  return `- id: dal-workflow-tools\n  name: 'dal-workflow-tools'\n  config:\n    stateRoot: ${stateRoot}${faultBlock}\n`;
}

/** The full composition patch: model route plus the typed workflow tools. */
export function buildCompositionPatch(
  provider: string,
  model: string,
  stateRoot: string,
  faults: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">> = {},
): string {
  return `${buildModelPatch(provider, model)}${buildToolsRow(stateRoot, faults)}`;
}
