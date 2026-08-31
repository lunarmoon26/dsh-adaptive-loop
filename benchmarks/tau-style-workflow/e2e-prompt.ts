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

/**
 * The multi-provider matrix. Every non-deepseek provider is a route owned by
 * the bundled `dsh-llm-pi-ai` adapter (catalog routes for openai / anthropic /
 * zai / moonshotai): the composition patch declares the route profile with
 * just its credential reference, and the adapter registers the route live,
 * resolving the key per request through the credential seam (inherited
 * environment in the container).
 */
export interface ProviderSpec {
  /** provider route registered on the llm seam */
  route: string;
  /** credential env reference the adapter resolves per request */
  apiKeyEnv: string;
  /** default fast-tier model for the matrix */
  defaultModel: string;
  /** which adapter row owns the route */
  adapterRow: "deepseek" | "pi-ai";
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  "deepseek-official": {
    route: "deepseek-official",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    adapterRow: "deepseek",
  },
  openai: {
    route: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-luna",
    adapterRow: "pi-ai",
  },
  anthropic: {
    route: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    adapterRow: "pi-ai",
  },
  zai: {
    route: "zai",
    apiKeyEnv: "ZAI_API_KEY",
    defaultModel: "glm-5.2",
    adapterRow: "pi-ai",
  },
  moonshotai: {
    route: "moonshotai",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k3",
    adapterRow: "pi-ai",
  },
};

export function providerSpec(provider: string): ProviderSpec {
  const spec = PROVIDERS[provider];
  if (spec === undefined) {
    throw new Error(`Unknown provider "${provider}"; supported: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return spec;
}

/**
 * The `llm-pi-ai` composition row declaring the provider route. Empty for
 * providers served by the deepseek adapter. A route profile that omits
 * `models` serves pi-ai's installed catalog unchanged, so only the
 * credential reference is needed.
 */
export function buildPiAiRow(provider: string): string {
  const spec = providerSpec(provider);
  if (spec.adapterRow !== "pi-ai") {
    return "";
  }
  return `- id: llm-pi-ai\n  config:\n    providers:\n      ${spec.route}:\n        apiKeyEnv: ${spec.apiKeyEnv}\n`;
}

/**
 * The tools row mounting the mock-service workflow tools in the container.
 */
export function buildToolsRow(
  stateRoot: string,
  faults: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">> = {},
  resolutions: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure">> = {},
): string {
  const faultLines = Object.entries(faults)
    .map(([kind, outcome]) => `      ${kind}: ${outcome}`)
    .join("\n");
  const faultBlock = faultLines === "" ? "" : `\n    faults:\n${faultLines}`;
  const resolutionLines = Object.entries(resolutions)
    .map(([kind, outcome]) => `      ${kind}: ${outcome}`)
    .join("\n");
  const resolutionBlock = resolutionLines === "" ? "" : `\n    resolutions:\n${resolutionLines}`;
  return `- id: dal-workflow-tools\n  name: 'dal-workflow-tools'\n  config:\n    stateRoot: ${stateRoot}${faultBlock}${resolutionBlock}\n`;
}

/** The full composition patch: model route, provider adapter route, tools. */
export function buildCompositionPatch(
  provider: string,
  model: string,
  stateRoot: string,
  faults: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">> = {},
  resolutions: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure">> = {},
): string {
  return `${buildModelPatch(provider, model)}${buildPiAiRow(provider)}${buildToolsRow(stateRoot, faults, resolutions)}`;
}
