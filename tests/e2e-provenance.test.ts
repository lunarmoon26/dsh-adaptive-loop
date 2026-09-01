import { describe, expect, it } from "vitest";

import { buildModelPatch } from "../benchmarks/tau-style-workflow/e2e-prompt.js";
import { SCHEMA_IDS, assertSchema } from "../src/schema.js";

describe("e2e provenance and business outcome (audit P0-4/P0-5)", () => {
  it("builds the model patch overlay declaring the batch route", () => {
    const patch = buildModelPatch("deepseek-official", "deepseek-v4-flash");
    expect(patch).toContain("id: agent-default-model");
    expect(patch).toContain("provider: deepseek-official");
    expect(patch).toContain("model: deepseek-v4-flash");
  });

  it("accepts run records carrying business_outcome and model_patch_sha256", async () => {
    const record = {
      $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
      schema_version: "1.0.0",
      run_id: "run-provenance-test-0001",
      task_id: "task-005-booking-refusal",
      change_id: "chg-provenance-test",
      started_at: "2026-08-30T00:00:00.000Z",
      finished_at: "2026-08-30T00:05:00.000Z",
      outcome: "succeeded",
      failure: null,
      business_outcome: {
        status: "failed",
        source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
        score: 0.5,
        earned: 1,
        total: 2,
      },
      checks: [{
        id: "effect:refusal",
        pass: false,
        detail: "required refusal effect was missing",
        goal_sha256: "d".repeat(64),
        actual_sha256: "e".repeat(64),
      }],
      context: {
        task_set: "tau-style-workflow-e2e",
        environment_snapshot: "test",
        tool_versions: [],
        model: { id: "deepseek-v4-flash", version: "deepseek-official" },
        prompt_sha256: "a".repeat(64),
        harness_sha256: null,
        model_patch_sha256: "b".repeat(64),
        grader_version: "1.0.0",
        seeds: [],
        context_policy_sha256: "c".repeat(64),
        inference_parameters: [],
        harness_pins: [
          { surface: "model_patch", uri: "repo://benchmarks/tau-style-workflow/.dal/benchmark/e2e/model-patch.yml", sha256: "b".repeat(64) },
        ],
      },
      artifacts: [],
      metrics: { duration_ms: 1000, tool_calls: 0 },
      evidence: ["dsh-session://provenance-test"],
      privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
    };
    await expect(assertSchema(SCHEMA_IDS.runRecord, record, "Run record")).resolves.toBeUndefined();
  });
});
