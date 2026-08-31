import { describe, expect, it } from "vitest";

import { buildCompositionPatch, buildPiAiRow, buildToolsRow, PROVIDERS, providerSpec } from "../benchmarks/tau-style-workflow/e2e-prompt.js";

describe("e2e multi-provider composition wiring", () => {
  it("declares the pi-ai route row for catalog providers", () => {
    const patch = buildCompositionPatch("openai", "gpt-5.4-mini", "/workspace/state");
    expect(patch).toContain("provider: openai");
    expect(patch).toContain("model: gpt-5.4-mini");
    expect(patch).toContain("- id: llm-pi-ai");
    expect(patch).toContain("apiKeyEnv: OPENAI_API_KEY");
  });

  it("keeps the deepseek adapter free of a pi-ai row", () => {
    const patch = buildCompositionPatch("deepseek-official", "deepseek-v4-flash", "/workspace/state");
    expect(patch).toContain("provider: deepseek-official");
    expect(patch).not.toContain("llm-pi-ai");
  });

  it("resolves every matrix provider to a route, key env, and default model", () => {
    expect(providerSpec("openai")).toMatchObject({ route: "openai", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.6-luna" });
    expect(providerSpec("anthropic")).toMatchObject({ route: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5" });
    expect(providerSpec("zai")).toMatchObject({ route: "zai", apiKeyEnv: "ZAI_API_KEY", defaultModel: "glm-5.2" });
    expect(providerSpec("moonshotai")).toMatchObject({ route: "moonshotai", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "kimi-k3" });
    expect(providerSpec("deepseek-official").adapterRow).toBe("deepseek");
  });

  it("rejects unknown providers by name", () => {
    expect(() => providerSpec("acme")).toThrow(/Unknown provider "acme"/);
    expect(() => buildPiAiRow("acme")).toThrow(/Unknown provider "acme"/);
  });

  it("emits an empty pi-ai row for deepseek-only providers", () => {
    expect(buildPiAiRow("deepseek-official")).toBe("");
  });

  it("keeps the registry complete for the documented matrix", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "deepseek-official", "moonshotai", "openai", "zai"].sort());
  });

  it("emits faults and unknown-outcome resolutions in the tools row", () => {
    const row = buildToolsRow("/state", { issue_refund: "unknown" }, { issue_refund: "success" });
    expect(row).toContain("faults:\n      issue_refund: unknown");
    expect(row).toContain("resolutions:\n      issue_refund: success");
  });
});
