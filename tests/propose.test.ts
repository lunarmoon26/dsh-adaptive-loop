import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { clusterRunRecords } from "../src/clustering.js";
import { prepareProposePayload, prepareProposeRequest, proposeDraft, runPropose } from "../src/propose.js";
import { prepareChatRequest } from "../src/propose-transport.js";
import { ingestRunRecord } from "../src/runs.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { assertSchema, SCHEMA_IDS } from "../src/schema.js";

const model = { provider: "deepseek-official", model: "deepseek-v4-flash" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
      requestDigest: prepareChatRequest(prepared.payload, model).requestDigest,
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
        requestDigest: prepareChatRequest(prepared.payload, model).requestDigest,
        runner: async () => JSON.stringify({ ...JSON.parse(validReply), surface: "evaluator" }),
        runnerKind: "injected",
        model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      }),
    ).rejects.toMatchObject({ code: "PROPOSE_REPLY_INVALID" });
    await expect(
      proposeDraft({
        payload: prepared.payload,
        payloadDigest: prepared.digest,
        requestDigest: prepareChatRequest(prepared.payload, model).requestDigest,
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

  it("records a draft under an approved decision with the exact request scope", async () => {
    const clusters = await makeClusters();
    const prepared = await prepareProposeRequest({ clustersDir: clusters, model });
    const approvalPath = join(await mkdtemp(join(tmpdir(), "dal-propose-dec-")), "decision.json");
    const decision = {
      $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
      schema_version: "1.0.0",
      decision_id: "dec-propose-approved",
      request_id: "req-propose-approved",
      action: "send_data_externally",
      scope: { kind: "data_transfer", value: prepared.requestDigest, sha256: sha256(prepared.requestDigest) },
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
    expect(result.draft.provenance.request_sha256).toBe(prepared.requestDigest);
    expect(result.draft.payload_sha256).toBe(prepared.digest);
    const stored = JSON.parse(await readFile(join(outputDir, "draft.json"), "utf8")) as { surface: string };
    expect(stored.surface).toBe("skills");
  });

  it("exposes prepare through the CLI without any model call", async () => {
    const clusters = await makeClusters();
    const requestPath = join(await mkdtemp(join(tmpdir(), "dal-propose-out-")), "request.json");
    const captured = captureIo();
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    expect(await runCli(["propose", "prepare", "--clusters", clusters, "--model", model.model, "--output", requestPath], captured.io)).toBe(0);
    const persisted = JSON.parse(await readFile(requestPath, "utf8"));
    expect(persisted).toMatchObject({ $schema: SCHEMA_IDS.proposerRequest, schema_version: "1.0.0", endpoint: "https://api.deepseek.com/chat/completions", body: { model: model.model } });
    await assertSchema(SCHEMA_IDS.proposerRequest, persisted, "Persisted proposer request");
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "prepared", request_digest: sha256(canonicalJson(persisted)) });
    expect(mock).not.toHaveBeenCalled();
  });

  it("documents explicit-model request preparation, direct run, and branch candidate input", async () => {
    const captured = captureIo();
    expect(await runCli(["help"], captured.io)).toBe(0);
    const lines = captured.stdout.join("").split("\n");
    const prepare = lines.find((line) => line.includes("dal propose prepare"));
    const run = lines.find((line) => line.includes("dal propose run"));
    expect(prepare).toContain("--model <m>");
    expect(prepare).toContain("--output <request-file>");
    expect(prepare).not.toContain("[--model");
    expect(run).toContain("--model <m>");
    expect(run).not.toMatch(/workspace|docker|\[--model/);
    expect(lines.find((line) => line.includes("dal branch record"))).toContain("[--candidate <file>]");
  });
});

describe("request approval confinement", () => {
  it("uses payload-only HTTPS with no workspace/profile reads or subprocess execution", async () => {
    const clustersDir = await makeClusters();
    const prepared = await prepareProposeRequest({ clustersDir, model });
    const approvalPath = await makeApproval(prepared.requestDigest);
    const outputPath = join(await mkdtemp(join(tmpdir(), "dal-propose-https-")), "draft.json");
    for (const name of ["propose.ts", "propose-transport.ts"]) {
      const source = await readFile(resolve(import.meta.dirname, "../src", name), "utf8");
      expect(source).not.toMatch(/node:child_process|\.\/docker\.js|spawnSync|runDocker|dotenv|--profile/);
      expect(source).not.toMatch(/readFile\(|options\.workspaceDir/);
    }
    vi.stubEnv("DEEPSEEK_API_KEY", "offline-test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: validReply } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPropose({ clustersDir, approvalPath, outputPath, model, runner: "local", workspaceDir: "/nonexistent-proposer-workspace" });
    expect(result.draft.provenance.runner).toBe("deepseek-https");
    expect(result.request_digest).toBe(prepared.requestDigest);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("missing approval never calls transport", async () => {
    const clustersDir = await makeClusters();
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(runPropose({ clustersDir, approvalPath: "/missing-decision.json", outputPath: "unused", model })).rejects.toMatchObject({ code: "FILE_READ_FAILED" });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["payload", "endpoint", "model", "prompt", "expired", "rejected", "action"])("rejects %s approval before any transport or credential use", async (drift) => {
    const clustersDir = await makeClusters();
    const prepared = await prepareProposeRequest({ clustersDir, model });
    const changed = structuredClone(prepared.request);
    if (drift === "endpoint") changed.endpoint = "https://example.invalid/chat/completions";
    if (drift === "model") changed.body.model = "different-model";
    if (drift === "prompt") changed.body.messages[0]!.content += " Different instructions.";
    const digest = drift === "payload" ? prepared.digest : sha256(canonicalJson(changed));
    const approvalPath = await makeApproval(digest, drift === "expired" ? { expires_at: "2026-01-01T00:00:00.000Z" } :
      drift === "rejected" ? { decision: "rejected" } : drift === "action" ? { action: "change_shared_harness_config", scope: { kind: "configuration", value: digest, sha256: sha256(digest) } } : {});
    const fetchMock = vi.fn(() => { throw new Error("unexpected transport"); });
    vi.stubGlobal("fetch", fetchMock);
    const env = process.env;
    const credentialRead = vi.fn();
    vi.stubGlobal("process", new Proxy(process, { get(target, key) {
      if (key !== "env") return Reflect.get(target, key);
      return new Proxy(env, { get(target, key) {
      if (key === "DEEPSEEK_API_KEY") credentialRead();
      return Reflect.get(target, key);
      } });
    } }));
    await expect(runPropose({ clustersDir, approvalPath, outputPath: "unused.json", model })).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(credentialRead).not.toHaveBeenCalled();
  });

  it("rejects Docker configuration before reading any input", async () => {
    await expect(runPropose({ clustersDir: "missing", approvalPath: "missing", outputPath: "unused", model, runner: "docker" }))
      .rejects.toMatchObject({ code: "PROPOSE_RUNNER_UNSUPPORTED" });
    await expect(runPropose({ clustersDir: "missing", approvalPath: "missing", outputPath: "unused", model, docker: { image: "anything", runFlags: ["--privileged"], envNames: [] } }))
      .rejects.toMatchObject({ code: "PROPOSE_RUNNER_UNSUPPORTED" });
  });

  it.each(["ghp_1234567890abcdefghij1234567890", "person@example.com"])("rejects sensitive replies without persistence", async (sensitive) => {
    const clustersDir = await makeClusters();
    const prepared = await prepareProposeRequest({ clustersDir, model });
    const approvalPath = await makeApproval(prepared.requestDigest);
    const outputPath = join(await mkdtemp(join(tmpdir(), "dal-propose-private-")), "draft.json");
    const result = runPropose({ clustersDir, approvalPath, outputPath, model,
      runnerOverride: async () => JSON.stringify({ ...JSON.parse(validReply), title: sensitive }),
    });
    await expect(result).rejects.toThrow("sensitive material");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeApproval(digest: string, changes: Record<string, unknown> = {}): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "dal-propose-approval-")), "decision.json");
  await writeFile(path, JSON.stringify({
    $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json", schema_version: "1.0.0",
    decision_id: "dec-request-test", request_id: "req-request-test", action: "send_data_externally",
    scope: { kind: "data_transfer", value: digest, sha256: sha256(digest) }, decision: "approved",
    reviewer: { kind: "human", id: "operator" }, decided_at: "2025-01-01T00:00:00.000Z",
    expires_at: "2027-09-06T00:00:00.000Z", rationale: "Approve exact request for offline verification.",
    evidence: ["repo://docs/proposer-request.md"], candidate_sha256: null, ...changes,
  }));
  return path;
}

async function makeClusters(): Promise<string> {
  const runs = await mkdtemp(join(tmpdir(), "dal-propose-runs-"));
  const clusters = await mkdtemp(join(tmpdir(), "dal-propose-clusters-"));
  await ingestRunRecord(fixture("dal", "fixtures", "run-benchmark-fail.json"), runs);
  await clusterRunRecords({ store: runs, output: clusters });
  return clusters;
}
