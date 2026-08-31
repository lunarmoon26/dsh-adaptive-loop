import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { apply as applyRunRecord, RunSessionRecorder } from "../plugins/dal-run-record/src/index.js";
import { apply as applyImproveTools } from "../plugins/dal-improve-tools/src/index.js";
import { SCHEMA_IDS, assertSchema } from "../src/schema.js";
import { clusterRunRecords } from "../src/clustering.js";
import { ingestRunRecord } from "../src/runs.js";
import { sha256 } from "../src/json.js";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const session = (id: string, cwd: string): { id: string; header: { createdAt: number; cwd?: string } } => ({
  id,
  header: { createdAt: Date.now() - 5000, cwd },
});

function event(type: string, data: Record<string, unknown>, seq: number): { seq: number; time: number; type: string; data: Record<string, unknown> } {
  return { seq, time: Date.now(), type, data };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dal-plugin-modes-"));
}

async function recordsIn(root: string): Promise<string[]> {
  const dir = join(root, ".dal", "runs");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

describe("run-mode recorder", () => {
  it("projects a failed session into a schema-valid run record with no raw content", async () => {
    const root = await workspace();
    const recorder = new RunSessionRecorder({ storeRoot: ".dal/runs", maxErrorFacts: 64 });
    const sessionId = "session-1";
    const systemText = "TOP-SECRET system prompt content";
    recorder.onEvent(session(sessionId, root), event("turn/start", { turn: 1 }, 0));
    recorder.onEvent(session(sessionId, root), event("step/start", { turn: 1, step: 1 }, 1));
    recorder.onEvent(session(sessionId, root), event("request/header", { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash", temperature: 0.7 }, system: systemText } }, 2));
    recorder.onEvent(session(sessionId, root), event("request/context", { provider: "deepseek-official", model: "deepseek-v4-flash" }, 3));
    recorder.onEvent(session(sessionId, root), event("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"rm -rf / secret"}' }, 4));
    recorder.onEvent(session(sessionId, root), event("tool/result", { turn: 1, step: 1, message: { content: "secret output" }, error: { name: "ToolError", code: "TIMEOUT_EXCEEDED" } }, 5));
    recorder.onEvent(session(sessionId, root), event("turn/end", { turn: 1, reason: { kind: "error", error: { code: "TIMEOUT_EXCEEDED" } } }, 6));
    await recorder.dispose(session(sessionId, root));

    const files = await recordsIn(root);
    expect(files).toEqual([`run-${sessionId}-s6.final.json`]);
    const record = JSON.parse(await readFile(join(root, ".dal", "runs", files[0]!), "utf8")) as Record<string, unknown>;
    await expect(assertSchema(SCHEMA_IDS.runRecord, record, "Run record")).resolves.toBeUndefined();

    expect(record.outcome).toBe("failed");
    expect(record.failure).toMatchObject({ category: "timeout", code: "timeout_exceeded" });
    expect(record.metrics).toMatchObject({ tool_calls: 1 });
    expect(record.context).toMatchObject({
      prompt_sha256: sha(systemText),
      model: { id: "deepseek-v4-flash", version: "deepseek-official" },
      inference_parameters: [{ name: "temperature", value: "0.7" }],
    });
    expect((record.context as { tool_versions: Array<{ name: string }> }).tool_versions).toEqual([
      { name: "bash", version: "unpinned" },
    ]);
    expect(record.evidence).toEqual([`dsh-session://${sessionId}`]);
    expect(record.business_outcome).toBeNull();
    expect(record.trace).toEqual([
      { seq: 4, turn: 1, step: 1, tool: "bash", outcome: "timeout", code: "TIMEOUT_EXCEEDED" },
    ]);

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(systemText);
    expect(serialized).not.toContain("secret");
  });

  it("records checkpoint records at flush and a final record at disposal", async () => {
    const root = await workspace();
    const recorder = new RunSessionRecorder({ storeRoot: ".dal/runs", maxErrorFacts: 64 });
    const id = "session-2";
    recorder.onEvent(session(id, root), event("turn/start", { turn: 1 }, 0));
    recorder.onEvent(session(id, root), event("turn/end", { turn: 1, reason: { kind: "completed" } }, 1));
    await recorder.flush(session(id, root));
    recorder.onEvent(session(id, root), event("turn/start", { turn: 2 }, 2));
    recorder.onEvent(session(id, root), event("turn/end", { turn: 2, reason: { kind: "blocked" } }, 3));
    await recorder.dispose(session(id, root));

    const files = (await recordsIn(root)).sort();
    expect(files).toEqual([`run-${id}-s1.json`, `run-${id}-s3.final.json`]);
    const checkpoint = JSON.parse(await readFile(join(root, ".dal", "runs", files[0]!), "utf8")) as Record<string, unknown>;
    const final = JSON.parse(await readFile(join(root, ".dal", "runs", files[1]!), "utf8")) as Record<string, unknown>;
    expect(checkpoint.outcome).toBe("succeeded");
    expect(final.outcome).toBe("blocked");
    expect(final.failure).toBeNull();
  });

  it("skips sessions without a cwd and never throws on malformed events", async () => {
    const root = await workspace();
    const recorder = new RunSessionRecorder({ storeRoot: ".dal/runs", maxErrorFacts: 64 });
    recorder.onEvent({ id: "session-3", header: { createdAt: Date.now() } }, event("turn/start", { turn: 1 }, 0));
    recorder.onEvent(session("session-4", root), { seq: 0, time: Date.now(), type: "tool/result", data: { not: "the shape" } } as never);
    recorder.onEvent(session("session-4", root), event("turn/end", { turn: 1, reason: { kind: "aborted" } }, 1));
    await recorder.dispose({ id: "session-3", header: { createdAt: Date.now() } });
    await recorder.dispose(session("session-4", root));
    const files = await recordsIn(root);
    expect(files).toEqual([`run-session-4-s1.final.json`]);
    const record = JSON.parse(await readFile(join(root, ".dal", "runs", files[0]!), "utf8")) as Record<string, unknown>;
    expect(record.outcome).toBe("aborted");
  });

  it("wires onto a Cordis context and records through emitted events", async () => {
    const root = await workspace();
    const ctx = new Context();
    applyRunRecord(ctx, { storeRoot: ".dal/runs" });
    const id = "session-5";
    (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
      "session/event",
      session(id, root),
      event("turn/start", { turn: 1 }, 0),
    );
    (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
      "session/event",
      session(id, root),
      event("turn/end", { turn: 1, reason: { kind: "completed" } }, 1),
    );
    (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit("session/disposed", session(id, root));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(await recordsIn(root)).toEqual([`run-${id}-s1.final.json`]);
  });
});

const distCli = resolve(import.meta.dirname, "..", "dist", "cli.js");

describe.skipIf(!existsSync(distCli))("improvement-mode workbench tools", () => {
  function captureTools(): {
    definitions: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>;
    ctx: { tools: { register: (definition: unknown) => void } };
  } {
    const definitions: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> = [];
    const ctx = {
      tools: {
        register: (definition: unknown) => {
          definitions.push(definition as { name: string; execute: (args: unknown) => Promise<unknown> });
        },
      },
    };
    applyImproveTools(ctx as never, { cliCommand: ["node", distCli] });
    return { definitions, ctx };
  }

  it("registers exactly the deterministic tool set", () => {
    const { definitions } = captureTools();
    expect(definitions.map((definition) => definition.name).sort()).toEqual([
      "dal_branch_evaluate",
      "dal_cluster_run",
      "dal_proposal_prepare",
      "dal_reset_status",
      "dal_run_summary",
    ]);
  });

  it("dal_reset_status reports a read-only dry run", async () => {
    const { definitions } = captureTools();
    const result = (await definitions.find((definition) => definition.name === "dal_reset_status")!.execute({})) as {
      ready: boolean;
      total_files: number;
      blocks: string[];
    };
    expect(typeof result.ready).toBe("boolean");
    expect(typeof result.total_files).toBe("number");
    expect(Array.isArray(result.blocks)).toBe(true);
  });

  it("dal_run_summary reports stored feedback counts", async () => {
    const { definitions } = captureTools();
    const result = (await definitions.find((definition) => definition.name === "dal_run_summary")!.execute({})) as {
      report: string;
    };
    expect(result.report).toContain("completed");
  });

  it("dal_cluster_run and dal_proposal_prepare work on a prepared run store", async () => {
    const root = await workspace();
    const runs = join(root, "runs");
    const clusters = join(root, "clusters");
    await ingestRunRecord(
      resolve(import.meta.dirname, "fixtures", "runs", "run-fixture-test-failure-1.json"),
      runs,
    );
    await clusterRunRecords({ store: runs, output: clusters });

    const { definitions } = captureTools();
    const clustered = (await definitions.find((definition) => definition.name === "dal_cluster_run")!.execute({
      store: runs,
      output: join(root, "clusters-2"),
    })) as { cluster_count: number; clustered_runs: number };
    expect(clustered.cluster_count).toBe(1);
    expect(clustered.clustered_runs).toBe(1);

    const prepared = (await definitions.find((definition) => definition.name === "dal_proposal_prepare")!.execute({
      clusters,
      runs,
      output: join(root, "payload.json"),
    })) as { payload_digest: string; payload_path: string };
    expect(prepared.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8")) as { clusters: unknown[] };
    expect(Array.isArray(payload.clusters)).toBe(true);
  });

  it("dal_branch_evaluate grades a candidate state deterministically", async () => {
    const root = await workspace();
    const store = join(root, "branches");
    const draftPath = join(root, "draft.json");
    const draft = {
      $schema: "https://recursive-dev-loop.dev/schemas/proposal-draft.v1.schema.json",
      schema_version: "1.0.0",
      draft_id: "drf-skills-fixture",
      created_at: "2026-08-29T19:00:00.000Z",
      payload_sha256: "a".repeat(64),
      model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      surface: "skills",
      target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
      base_sha256: "b".repeat(64),
      title: "Fixture draft",
      objective: "Exercise the branch ledger.",
      statement: "Raises task_success_rate by at least 0.1.",
      improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }],
      regressions: [],
      provenance: { runner: "injected", clusters: [] },
    };
    await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    const { recordBranch } = await import("../src/branch.js");
    await recordBranch({ branchId: "brn-plugin-modes-0001", parentBranchId: null, draftPath, store });

    const { definitions } = captureTools();
    const result = (await definitions.find((definition) => definition.name === "dal_branch_evaluate")!.execute({
      branch: "brn-plugin-modes-0001",
      task: "benchmarks/tau-style-workflow/tasks/task-001-refund.json",
      state: "benchmarks/tau-style-workflow/dal/fixtures/result-pass.json",
      store,
    })) as { passed: boolean; score: number };
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });
});

describe("mode bundle manifest", () => {
  it("declares a dsh.bundle patch with the recorder on and the tools off", async () => {
    const root = resolve(import.meta.dirname, "..", "plugins", "dal-modes");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name: string;
      dsh: { bundle: { patch: string } };
    };
    expect(manifest.name).toBe("@lunarmoon26/dal-modes");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    const patch = await readFile(join(root, manifest.dsh.bundle.patch), "utf8");
    expect(patch).toContain("id: dal-run-record");
    expect(patch).toContain("name: '@lunarmoon26/dal-run-record'");
    expect(patch).toContain("id: dal-improve-tools");
    expect(patch).toContain("disabled: true");
  });

  it("pins a run-record store digest for the recorded workspace policy", async () => {
    const root = await workspace();
    await mkdir(join(root, "config"));
    const policy = `{"policy": "pinned-${Math.random()}"}`;
    await writeFile(join(root, "config", "policy.v1.json"), policy);
    const recorder = new RunSessionRecorder({ storeRoot: ".dal/runs", maxErrorFacts: 64 });
    const id = "session-6";
    recorder.onEvent(session(id, root), event("turn/start", { turn: 1 }, 0));
    recorder.onEvent(session(id, root), event("turn/end", { turn: 1, reason: { kind: "completed" } }, 1));
    await recorder.dispose(session(id, root));
    const files = await recordsIn(root);
    const record = JSON.parse(await readFile(join(root, ".dal", "runs", files[0]!), "utf8")) as {
      context: { context_policy_sha256: string | null };
    };
    expect(record.context.context_policy_sha256).toBe(sha256(policy));
  });
});
