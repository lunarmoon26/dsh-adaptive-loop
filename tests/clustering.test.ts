import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { clusterRunRecords, failureSignature } from "../src/clustering.js";
import { ingestRunRecord, validateRunRecord } from "../src/runs.js";
import type { ClusterRecord, RunRecord } from "../src/types.js";

const fixture = (...parts: string[]): string => resolve(import.meta.dirname, "fixtures", ...parts);

async function readFixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(fixture(...parts), "utf8")) as T;
}

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

async function tempStore(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("deterministic self-improvement loop", () => {
  it("stores a run record immutably and retries idempotently", async () => {
    const store = await tempStore("dal-runs-");
    const first = await ingestRunRecord(fixture("runs", "run-fixture-test-failure-1.json"), store);
    expect(first.status).toBe("stored");
    const second = await ingestRunRecord(fixture("runs", "run-fixture-test-failure-1.json"), store);
    expect(second.status).toBe("idempotent");
    expect(second.run_sha256).toBe(first.run_sha256);

    const stored = JSON.parse(await readFile(join(store, "run-fixture-test-failure-1.json"), "utf8")) as RunRecord;
    expect(stored.run_id).toBe("run-fixture-test-failure-1");
    expect(stored.outcome).toBe("failed");
  });

  it("rejects a conflicting run ID with different content", async () => {
    const store = await tempStore("dal-runs-");
    await ingestRunRecord(fixture("runs", "run-fixture-test-failure-1.json"), store);
    const clone = await readFixture<RunRecord>("runs", "run-fixture-test-failure-1.json");
    clone.metrics.duration_ms = 1;
    await expect(validateRunRecord(clone)).resolves.toBeTruthy();
    const path = join(store, "clone.json");
    await writeFile(path, `${JSON.stringify(clone, null, 2)}\n`, "utf8");
    await expect(ingestRunRecord(path, store)).rejects.toMatchObject({ code: "RUN_ID_CONFLICT" });
  });

  it("fails closed when outcomes and failure facts disagree", async () => {
    const failedWithoutFailure = await readFixture<RunRecord>("runs", "run-fixture-test-failure-1.json");
    failedWithoutFailure.failure = null;
    await expect(validateRunRecord(failedWithoutFailure)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });

    const succeededWithFailure = await readFixture<RunRecord>("runs", "run-fixture-succeeded.json");
    succeededWithFailure.failure = {
      category: "runtime_error",
      code: "unexpected-error",
      fingerprint_extra: [],
      summary: "should not happen",
      evidence: ["repo://tests/fixtures/feedback/completed.json"],
    };
    await expect(validateRunRecord(succeededWithFailure)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });

    const blockedWithFailure = await readFixture<RunRecord>("runs", "run-fixture-test-failure-1.json");
    blockedWithFailure.outcome = "blocked";
    await expect(validateRunRecord(blockedWithFailure)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });

    const failedWithBusinessVerdict = await readFixture<RunRecord>("runs", "run-fixture-test-failure-1.json");
    failedWithBusinessVerdict.business_outcome = {
      status: "failed",
      source: "repo://tests/fixtures/runs/run-fixture-test-failure-1.json",
    };
    failedWithBusinessVerdict.checks = [{
      id: "goal:state",
      pass: false,
      detail: "business verdict must not accompany a failed harness",
      goal_sha256: "5".repeat(64),
      actual_sha256: "6".repeat(64),
    }];
    await expect(validateRunRecord(failedWithBusinessVerdict)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });

    const businessFailureWithoutFailedCheck = await readFixture<RunRecord>("runs", "run-fixture-succeeded.json");
    businessFailureWithoutFailedCheck.business_outcome = {
      status: "failed",
      source: "repo://tests/fixtures/runs/run-fixture-succeeded.json",
    };
    businessFailureWithoutFailedCheck.checks = [];
    await expect(validateRunRecord(businessFailureWithoutFailedCheck)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("rejects an evaluation-eligible run that spans HMR generations", async () => {
    const run = await readFixture<RunRecord>("runs", "run-fixture-succeeded.json");
    run.context.candidate_generation!.end_hmr_sequence = 8;
    await expect(validateRunRecord(run)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });
  });

  it("rejects evaluation eligibility on a checkpoint record", async () => {
    const run = await readFixture<RunRecord>("runs", "run-fixture-succeeded.json");
    run.record_stage = "checkpoint";
    await expect(validateRunRecord(run)).rejects.toMatchObject({ code: "RUN_RECORD_INVALID" });
  });

  it("clusters a completed business failure separately from a harness failure", async () => {
    const store = await tempStore("dal-runs-");
    const output = await tempStore("dal-clusters-");
    await ingestRunRecord(fixture("runs", "run-fixture-test-failure-1.json"), store);
    const business = await readFixture<RunRecord>("runs", "run-fixture-succeeded.json");
    business.run_id = "run-fixture-business-failure";
    business.business_outcome = {
      status: "failed",
      source: "repo://tests/fixtures/runs/run-fixture-succeeded.json",
      score: 0,
      earned: 0,
      total: 1,
    };
    business.checks = [
      {
        id: "goal:refunds",
        pass: false,
        detail: "state does not match the annotated goal",
        goal_sha256: "5".repeat(64),
        actual_sha256: "6".repeat(64),
      },
    ];
    const path = join(store, "..", "business.json");
    await writeFile(path, `${JSON.stringify(business, null, 2)}\n`, "utf8");
    await ingestRunRecord(path, store);

    const result = await clusterRunRecords({ store, output });
    expect(result.cluster_count).toBe(2);
    expect(result.clustered_harness_failures).toBe(1);
    expect(result.clustered_business_failures).toBe(1);
    expect(result.skipped_successful_runs).toBe(0);
    const categories = await Promise.all(
      result.clusters.map(async (cluster) =>
        (JSON.parse(await readFile(cluster.path, "utf8")) as ClusterRecord).fingerprint.category,
      ),
    );
    expect(categories.sort()).toEqual(["business_failure", "test_failure"]);
  });

  it("computes deterministic fingerprints that split on extra fields", () => {
    const run = JSON.parse(
      JSON.stringify({ failure: { category: "test_failure", code: "assertion-mismatch", fingerprint_extra: [] } }),
    ) as RunRecord;
    const first = failureSignature(run);
    expect(failureSignature(run)).toBe(first);
    (run.failure as RunRecord["failure"] & object)!.fingerprint_extra = ["other"];
    expect(failureSignature(run)).not.toBe(first);
  });

  it("clusters same-signature failures, skips successes, and publishes immutable records", async () => {
    const store = await tempStore("dal-runs-");
    const output = await tempStore("dal-clusters-");
    await ingestRunRecord(fixture("runs", "run-fixture-test-failure-1.json"), store);
    await ingestRunRecord(fixture("runs", "run-fixture-test-failure-2.json"), store);
    await ingestRunRecord(fixture("runs", "run-fixture-build-failure.json"), store);
    await ingestRunRecord(fixture("runs", "run-fixture-succeeded.json"), store);

    const result = await clusterRunRecords({ store, output });
    expect(result.cluster_count).toBe(2);
    expect(result.clustered_runs).toBe(3);
    expect(result.skipped_successful_runs).toBe(1);
    expect(result.clustered_harness_failures).toBe(3);
    expect(result.clustered_business_failures).toBe(0);

    const testCluster = result.clusters.find((cluster) => cluster.cluster_id.startsWith("clu-test_failure-"));
    expect(testCluster?.member_count).toBe(2);
    const record = JSON.parse(await readFile(testCluster!.path, "utf8")) as ClusterRecord;
    expect(record.tier).toBe("fingerprint");
    expect(record.evaluator).toBe("rdl-deterministic-clustering-v1");
    expect(record.members).toHaveLength(2);
    expect(record.members.map((member) => member.run_id).sort()).toEqual([
      "run-fixture-test-failure-1",
      "run-fixture-test-failure-2",
    ]);
    expect(record.representative.run_id).toBe("run-fixture-test-failure-1");
    expect(record.fingerprint.category).toBe("test_failure");

    const rerun = await clusterRunRecords({ store, output });
    expect(rerun.cluster_count).toBe(2);
    expect(rerun.clusters.every((cluster) => cluster.status === "idempotent")).toBe(true);
  });

  it("fails closed when a run store contains an invalid record", async () => {
    const store = await tempStore("dal-runs-");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "broken.json"), '{"not":"a run record"}\n', "utf8");
    await expect(clusterRunRecords({ store })).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("fails closed when the run store is missing", async () => {
    const missing = join(await tempStore("dal-empty-"), "does-not-exist");
    await expect(clusterRunRecords({ store: missing })).rejects.toMatchObject({ code: "CLUSTER_STORE_MISSING" });
  });

  it("exposes run and cluster commands through the CLI", async () => {
    const store = await tempStore("dal-runs-");
    const output = await tempStore("dal-clusters-");
    const captured = captureIo();
    expect(await runCli(["run", "ingest", fixture("runs", "run-fixture-test-failure-1.json"), "--store", store], captured.io)).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "stored" });

    const second = captureIo();
    expect(await runCli(["cluster", "run", "--store", store, "--output", output, "--format", "json"], second.io)).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({ cluster_count: 1, clustered_runs: 1 });
    expect(await readdir(output)).toHaveLength(1);
  });
});

describe("fingerprint + batch cluster identity", () => {
  it("produces distinct clusters per batch for the same failure fingerprint", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { randomUUID } = await import("node:crypto");
    const { ingestRunRecord } = await import("../src/runs.js");

    const root = await mkdtemp(join(tmpdir(), "dal-cluster-batch-"));
    const store = join(root, "runs");
    const output = join(root, "clusters");
    await (await import("node:fs/promises")).mkdir(store, { recursive: true });

    const makeRecord = (batch: string, runId: string) => ({
      $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
      schema_version: "1.0.0",
      run_id: runId,
      task_id: "task-005-booking-refusal",
      change_id: "chg-cluster-batch-test",
      started_at: "2026-08-30T00:00:00.000Z",
      finished_at: "2026-08-30T00:05:00.000Z",
      outcome: "failed",
      failure: {
        category: "test_failure",
        code: "check-goal-bookings",
        fingerprint_extra: ["goal:bookings"],
        summary: "state does not match the annotated goal",
        evidence: ["repo://benchmarks/tau-style-workflow/grader/grade.ts"],
      },
      context: {
        task_set: "tau-style-workflow-e2e",
        environment_snapshot: "test",
        tool_versions: [],
        model: { id: "deepseek-v4-flash", version: "deepseek-official" },
        prompt_sha256: "a".repeat(64),
        harness_sha256: null,
        grader_version: "1.0.0",
        seeds: [],
        context_policy_sha256: "b".repeat(64),
        inference_parameters: [],
      },
      artifacts: [],
      metrics: { duration_ms: 1000, tool_calls: 0 },
      batch_id: batch,
      evidence: ["dsh-session://cluster-batch-test"],
      privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
    });

    for (const [batch, runId] of [
      ["b1", `run-batch-a-${randomUUID().slice(0, 8)}`],
      ["b2", `run-batch-b-${randomUUID().slice(0, 8)}`],
    ] as const) {
      const path = join(root, `${runId}.json`);
      await writeFile(path, `${JSON.stringify(makeRecord(batch, runId), null, 2)}\n`);
      await ingestRunRecord(path, store);
    }

    const result = await clusterRunRecords({ store, output });
    expect(result.cluster_count).toBe(2);
    const batchIds = result.clusters.map((cluster) => cluster.cluster_id);
    expect(new Set(batchIds).size).toBe(2);

    const filtered = await clusterRunRecords({ store, output: join(root, "clusters-b1"), batch: "b1" });
    expect(filtered.cluster_count).toBe(1);
    const record = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "clusters-b1", `${filtered.clusters[0]!.cluster_id}.json`), "utf8"));
    expect(record.batch_id).toBe("b1");
  });
});
