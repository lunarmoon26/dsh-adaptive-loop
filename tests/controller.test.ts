import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  estimateControllerState,
  validateControllerPolicy,
  validateControllerState,
  wilsonScore95,
} from "../src/control/index.js";
import type { ControllerPolicy, RunRecord } from "../src/types.js";

const fixture = (...parts: string[]): string => resolve(import.meta.dirname, "fixtures", "controller", ...parts);

function captureIo(): { stdout: string[]; stderr: string[]; io: { stdout(text: string): void; stderr(text: string): void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

async function policyFile(mutator: (policy: ControllerPolicy) => void): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dal-control-policy-"));
  const policy = JSON.parse(await readFile(fixture("controller-policy.json"), "utf8")) as ControllerPolicy;
  mutator(policy);
  const path = join(root, "controller-policy.json");
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return path;
}

async function runStore(mutator: (run: RunRecord, name: string) => void): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dal-control-runs-"));
  for (const name of await readdir(fixture("runs"))) {
    const run = JSON.parse(await readFile(fixture("runs", name), "utf8")) as RunRecord;
    mutator(run, name);
    await writeFile(join(root, name), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }
  return root;
}

describe("run-to-run controller observation", () => {
  it("publishes deterministic Wilson estimates from one compatible batch", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-control-state-"));
    const options = {
      policyPath: fixture("controller-policy.json"),
      batchId: "batch-control-001",
      runs: fixture("runs"),
      store,
    };
    const first = await estimateControllerState(options);
    expect(first.status).toBe("stored");
    expect(first.state.status).toBe("ready");
    expect(first.state.estimated_at).toBe("2026-09-02T00:03:30.000Z");
    expect(first.state.observations).toMatchObject({
      batch_id: "batch-control-001",
      run_count: 3,
      seeds: [101, 102, 103],
    });
    expect(first.state.generation.harness_sha256).toBe("2".repeat(64));

    const metrics = Object.fromEntries(first.state.metrics.map((metric) => [metric.metric_id, metric]));
    expect(metrics["harness-success"]).toMatchObject({ successes: 2, failures: 1, excluded: 0, sample_count: 3 });
    expect(metrics["business-success"]).toMatchObject({ successes: 1, failures: 1, excluded: 1, sample_count: 2 });
    expect(metrics["identity-check-success"]).toMatchObject({
      successes: 1,
      failures: 1,
      excluded: 1,
      sample_count: 2,
    });
    expect(metrics["business-success"]!.mean).toBe(0.5);
    expect(metrics["business-success"]!.ci_low).toBeCloseTo(0.0945312057, 8);
    expect(metrics["business-success"]!.ci_high).toBeCloseTo(0.9054687943, 8);

    const retry = await estimateControllerState(options);
    expect(retry.status).toBe("idempotent");
    expect(retry.state.state_id).toBe(first.state.state_id);
    expect(retry.state_sha256).toBe(first.state_sha256);
  });

  it("marks the state insufficient when one configured denominator is too small", async () => {
    const policy = await policyFile((value) => {
      value.metrics.find((metric) => metric.metric_id === "identity-check-success")!.minimum_samples = 3;
    });
    const result = await estimateControllerState({
      policyPath: policy,
      batchId: "batch-control-001",
      runs: fixture("runs"),
      store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
    });
    expect(result.state.status).toBe("insufficient_evidence");
    expect(result.state.metrics.find((metric) => metric.metric_id === "identity-check-success")).toMatchObject({
      sample_count: 2,
      sufficient_evidence: false,
    });
  });

  it("fails closed when selected runs mix measurement contexts or harness generations", async () => {
    const mixedContext = await runStore((run, name) => {
      if (name.includes("business-fail")) run.context.environment_snapshot = "different-environment";
    });
    await expect(
      estimateControllerState({
        policyPath: fixture("controller-policy.json"),
        batchId: "batch-control-001",
        runs: mixedContext,
        store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_CONTEXT_MISMATCH" });

    const mixedGeneration = await runStore((run, name) => {
      if (name.includes("business-fail")) run.context.harness_sha256 = "9".repeat(64);
    });
    await expect(
      estimateControllerState({
        policyPath: fixture("controller-policy.json"),
        batchId: "batch-control-001",
        runs: mixedGeneration,
        store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_GENERATION_MISMATCH" });

    const duplicateCheck = await runStore((run, name) => {
      if (name.includes("pass-001") && !name.includes("business")) {
        run.checks!.push(structuredClone(run.checks![1]!));
      }
    });
    await expect(
      estimateControllerState({
        policyPath: fixture("controller-policy.json"),
        batchId: "batch-control-001",
        runs: duplicateCheck,
        store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_CHECK_DUPLICATE" });

    await expect(
      estimateControllerState({
        policyPath: fixture("controller-policy.json"),
        batchId: " batch-control-001 ",
        runs: fixture("runs"),
        store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_BATCH_INVALID" });
  });

  it("rejects ambiguous policy sources and tampered state statistics", async () => {
    const policy = JSON.parse(await readFile(fixture("controller-policy.json"), "utf8")) as ControllerPolicy;
    policy.metrics.push({
      metric_id: "duplicate-business-source",
      source: { kind: "business_outcome" },
      target: 0.7,
      deadband: 0.05,
      minimum_samples: 2,
    });
    await expect(validateControllerPolicy(policy)).rejects.toMatchObject({ code: "CONTROL_POLICY_INVALID" });

    const result = await estimateControllerState({
      policyPath: fixture("controller-policy.json"),
      batchId: "batch-control-001",
      runs: fixture("runs"),
      store: await mkdtemp(join(tmpdir(), "dal-control-state-")),
    });
    const tampered = structuredClone(result.state);
    tampered.metrics[0]!.ci_low = 0;
    await expect(validateControllerState(tampered)).rejects.toMatchObject({ code: "CONTROL_STATE_INVALID" });

    const coherentlyTampered = structuredClone(result.state);
    coherentlyTampered.metrics[0]!.target = 0.74;
    await expect(validateControllerState(coherentlyTampered)).rejects.toMatchObject({ code: "CONTROL_STATE_INVALID" });
  });

  it("returns null bounds for an empty denominator and rejects invalid estimator counts", () => {
    expect(wilsonScore95(0, 0)).toEqual({ mean: null, ci_low: null, ci_high: null });
    expect(() => wilsonScore95(2, 1)).toThrowError(expect.objectContaining({ code: "CONTROL_ESTIMATOR_INVALID" }));
  });

  it("exposes the observation-only command through the CLI", async () => {
    const captured = captureIo();
    const store = await mkdtemp(join(tmpdir(), "dal-control-cli-"));
    expect(
      await runCli(
        [
          "control",
          "estimate",
          "--policy",
          fixture("controller-policy.json"),
          "--batch",
          "batch-control-001",
          "--runs",
          fixture("runs"),
          "--store",
          store,
        ],
        captured.io,
      ),
    ).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      status: "stored",
      controller_status: "ready",
      task_class: "tau-style-workflow",
      batch_id: "batch-control-001",
    });

    const help = captureIo();
    expect(await runCli(["help"], help.io)).toBe(0);
    expect(help.stdout.join("")).toContain("dal control estimate --policy");
  });
});
