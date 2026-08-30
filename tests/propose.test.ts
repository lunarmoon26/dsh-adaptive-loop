import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { clusterRunRecords } from "../src/clustering.js";
import { prepareProposePayload, proposeDraft, runPropose } from "../src/propose.js";
import { ingestRunRecord } from "../src/runs.js";
import { sha256 } from "../src/json.js";

const workspace = resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow");
const fixture = (...parts: string[]): string => resolve(workspace, ...parts);

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

const validReply = JSON.stringify({
  surface: "skills",
  target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
  base_sha256: "9".repeat(64),
  title: "Require return labels before full refunds",
  objective: "Fix the refund workflow so full refunds always create a return label first.",
  statement: "Applying this change raises task_success_rate by at least 0.2 on the held-out cases without regressing golden cases.",
  improvements: [{ metric: "task_success_rate", expected_delta: 0.2 }],
  regressions: [{ summary: "Slower refunds when labels are unavailable.", severity: "low" }],
});

describe("governed proposer", () => {
  it("prepares a sanitized payload from cluster records without raw run content", async () => {
    const runs = await mkdtemp(join(tmpdir(), "dal-propose-runs-"));
    const clusters = await mkdtemp(join(tmpdir(), "dal-propose-clusters-"));
    await ingestRunRecord(fixture("dal", "fixtures", "run-benchmark-fail.json"), runs);
    await ingestRunRecord(fixture("dal", "fixtures", "run-benchmark-pass.json"), runs);
    await clusterRunRecords({ store: runs, output: clusters });

    const prepared = await prepareProposePayload({ clustersDir: clusters, runsDir: runs });
    expect(prepared.payload.clusters).toHaveLength(1);
    expect(prepared.payload.clusters[0]?.code).toBe("grader-mismatch");
    expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.json).toContain("omitted the required return label");
    expect(prepared.json).toContain("representative_failure");
  });

  it("turns a valid model reply into a schema-valid proposal draft", async () => {
    const prepared = await prepareProposePayload({ clustersDir: await makeClusters() });
    const draft = await proposeDraft({
      payload: prepared.payload,
      payloadDigest: prepared.digest,
      runner: async () => validReply,
      runnerKind: "injected",
      model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    });
    expect(draft.surface).toBe("skills");
    expect(draft.payload_sha256).toBe(prepared.digest);
    expect(draft.provenance.clusters[0]?.code).toBe("grader-mismatch");
  });

  it("rejects replies on an ineditable surface or without JSON", async () => {
    const prepared = await prepareProposePayload({ clustersDir: await makeClusters() });
    await expect(
      proposeDraft({
        payload: prepared.payload,
        payloadDigest: prepared.digest,
        runner: async () => JSON.stringify({ ...JSON.parse(validReply), surface: "evaluator" }),
        runnerKind: "injected",
        model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      }),
    ).rejects.toMatchObject({ code: "PROPOSE_REPLY_INVALID" });
    await expect(
      proposeDraft({
        payload: prepared.payload,
        payloadDigest: prepared.digest,
        runner: async () => "no json here",
        runnerKind: "injected",
        model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      }),
    ).rejects.toMatchObject({ code: "PROPOSE_REPLY_INVALID" });
  });

  it("fails closed without an approved send_data_externally decision", async () => {
    const clusters = await makeClusters();
    const approvalPath = join(await mkdtemp(join(tmpdir(), "dal-propose-dec-")), "decision.json");
    const decision = {
      $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
      schema_version: "1.0.0",
      decision_id: "dec-propose-test",
      request_id: "req-propose-test",
      action: "send_data_externally",
      scope: { kind: "data_transfer", value: "e".repeat(64), sha256: sha256("e".repeat(64)) },
      decision: "approved",
      reviewer: { kind: "human", id: "operator" },
      decided_at: "2026-08-29T18:00:00.000Z",
      expires_at: "2027-08-30T18:00:00.000Z",
      rationale: "Wrong-scope test decision.",
      evidence: ["repo://docs/spec.md"],
      candidate_sha256: null,
    };
    await writeFile(approvalPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    await expect(
      runPropose({
        clustersDir: clusters,
        approvalPath,
        workspaceDir: workspace,
        outputPath: join(await mkdtemp(join(tmpdir(), "dal-propose-out-")), "draft.json"),
        model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
        runnerOverride: async () => validReply,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  });

  it("records a draft under an approved decision with the exact payload scope", async () => {
    const clusters = await makeClusters();
    const prepared = await prepareProposePayload({ clustersDir: clusters });
    const approvalPath = join(await mkdtemp(join(tmpdir(), "dal-propose-dec-")), "decision.json");
    const decision = {
      $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
      schema_version: "1.0.0",
      decision_id: "dec-propose-approved",
      request_id: "req-propose-approved",
      action: "send_data_externally",
      scope: { kind: "data_transfer", value: prepared.digest, sha256: sha256(prepared.digest) },
      decision: "approved",
      reviewer: { kind: "human", id: "operator" },
      decided_at: "2026-08-29T18:00:00.000Z",
      expires_at: "2027-08-30T18:00:00.000Z",
      rationale: "Operator approves sending exactly this sanitized payload.",
      evidence: ["repo://docs/spec.md"],
      candidate_sha256: null,
    };
    await writeFile(approvalPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    const outputDir = await mkdtemp(join(tmpdir(), "dal-propose-out-"));
    const result = await runPropose({
      clustersDir: clusters,
      approvalPath,
      workspaceDir: workspace,
      outputPath: join(outputDir, "draft.json"),
      model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      runnerOverride: async () => validReply,
    });
    expect(result.status).toBe("recorded");
    const stored = JSON.parse(await readFile(join(outputDir, "draft.json"), "utf8")) as { surface: string };
    expect(stored.surface).toBe("skills");
  });

  it("exposes prepare through the CLI without any model call", async () => {
    const clusters = await makeClusters();
    const payloadPath = join(await mkdtemp(join(tmpdir(), "dal-propose-out-")), "payload.json");
    const captured = captureIo();
    expect(await runCli(["propose", "prepare", "--clusters", clusters, "--output", payloadPath], captured.io)).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "prepared" });
  });
});

async function makeClusters(): Promise<string> {
  const runs = await mkdtemp(join(tmpdir(), "dal-propose-runs-"));
  const clusters = await mkdtemp(join(tmpdir(), "dal-propose-clusters-"));
  await ingestRunRecord(fixture("dal", "fixtures", "run-benchmark-fail.json"), runs);
  await clusterRunRecords({ store: runs, output: clusters });
  return clusters;
}
