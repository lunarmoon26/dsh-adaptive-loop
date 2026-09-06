import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { sha256 } from "../src/json.js";
import {
  evaluateOptimizerCandidate,
  prepareOptimizerExchange,
} from "../src/optimizer-adapter.js";
import { validateOptimizerExchange } from "../src/optimizer.js";
import { ingestRunRecord } from "../src/runs.js";
import { SCHEMA_IDS, assertSchema } from "../src/schema.js";
import type { OptimizerCandidate, OptimizerExchange } from "../src/types.js";

const repoRoot = resolve(import.meta.dirname, "..");
const skillPath = resolve(
  repoRoot,
  "benchmarks",
  "tau-style-workflow",
  ".agents",
  "skills",
  "refund-workflow",
  "SKILL.md",
);

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dal-optimizer-"));
}

async function failedRunStore(store: string): Promise<void> {
  const record = {
    $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
    schema_version: "1.0.0",
    run_id: `run-adapter-test-fail-${randomUUID().slice(0, 8)}`,
    task_id: "task-005-booking-refusal",
    change_id: "chg-adapter-test",
    started_at: "2026-08-29T23:00:00.000Z",
    finished_at: "2026-08-29T23:05:00.000Z",
    outcome: "succeeded",
    failure: null,
    business_outcome: {
      status: "failed",
      source: "repo://benchmarks/tau-style-workflow/grader/grade.ts",
      score: 0,
      earned: 0,
      total: 1,
    },
    context: {
      task_set: "tau-style-workflow-e2e",
      environment_snapshot: "test",
      tool_versions: [],
      model: { id: "deepseek-v4-flash", version: "deepseek-official" },
      prompt_sha256: sha256("prompt"),
      harness_sha256: null,
      grader_version: "2.0.0",
      seeds: [],
      context_policy_sha256: sha256("policy"),
      inference_parameters: [],
      harness_pins: [
        { surface: "skills", uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md", sha256: sha256("skill-v1") },
      ],
    },
    artifacts: [],
    metrics: { duration_ms: 300000, tool_calls: 3 },
    batch_id: "baseline",
    checks: [
      {
        id: "goal:bookings",
        pass: false,
        detail: "state does not match the annotated goal",
        goal_sha256: sha256("goal"),
        actual_sha256: sha256("actual"),
        weight: 2,
        gated: { reason: "upstream goal failed", upstream: "goal:bookings" },
      },
    ],
    trace: [{ seq: 4, turn: 1, step: 1, tool: "change_booking", outcome: "ok", code: null }],
    evidence: ["dsh-session://adapter-test"],
    privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
  };
  await mkdir(store, { recursive: true });
  const path = join(store, "..", "record.json");
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await ingestRunRecord(path, store);
}

function candidateFor(exchange: OptimizerExchange, edits: OptimizerCandidate["edits"], overrides: Partial<OptimizerCandidate> = {}): OptimizerCandidate {
  return {
    $schema: "https://recursive-dev-loop.dev/schemas/optimizer-candidate.v1.schema.json",
    schema_version: "1.0.0",
    candidate_id: `cand-test-${randomUUID().slice(0, 8)}`,
    exchange_id: exchange.exchange_id,
    surface: "skills",
    target_uri: exchange.target.artifact_uri,
    base_sha256: exchange.target.base_sha256,
    title: "Add a verification rule",
    objective: "Fix goal:bookings failures",
    statement: "Adds the exact-goal-shape rule.",
    improvements: [{ metric: "task_success_rate", expected_delta: 0.2 }],
    regressions: [],
    edits,
    ...overrides,
  };
}

const validEdit = {
  anchor: "## Rules",
  before: "- Never exceed the order total.",
  after: "- Never exceed the order total.\n- Adapter rule: always verify against goal_state.",
};

describe("optimizer adapter (prepare/evaluate-only)", () => {
  it("prepares a sanitized SkillOpt training set from the run store", async () => {
    const root = await workspace();
    const store = join(root, "runs");
    await failedRunStore(store);
    const prepared = await prepareOptimizerExchange({ skillPath, store });
    expect(prepared.exchange.provider_hint).toBe("skillopt");
    expect(prepared.exchange.mode).toBe("prepare_only");
    expect(prepared.exchange.privacy.external_transfer_approved).toBe(false);
    await expect(validateOptimizerExchange(prepared.exchange)).resolves.toBeDefined();
    await expect(
      assertSchema(SCHEMA_IDS.optimizerTrainingSet, prepared.trainingSet, "Training set"),
    ).resolves.toBeUndefined();
    expect(prepared.trainingSet.episodes).toHaveLength(1);
    expect(prepared.trainingSet.episodes[0]!.failure).toBeNull();
    expect(prepared.trainingSet.episodes[0]!.business_outcome).toMatchObject({ status: "failed", score: 0 });
    expect(prepared.trainingSet.episodes[0]!.checks[0]!.pass).toBe(false);
    expect(prepared.trainingSet.episodes[0]!.checks[0]).toMatchObject({
      weight: 2,
      gated: { upstream: "goal:bookings" },
    });
    expect(prepared.trainingSet.episodes[0]!.trace).toHaveLength(1);
    expect(prepared.trainingSet.target.base_sha256).toBe(sha256(await readFile(skillPath, "utf8")));
  });

  it("validates a bounded-edits candidate and reconstructs its digest", async () => {
    const root = await workspace();
    const store = join(root, "runs");
    await failedRunStore(store);
    const prepared = await prepareOptimizerExchange({ skillPath, store });
    const candidate = candidateFor(prepared.exchange, [validEdit]);
    const exchangePath = join(root, "exchange.json");
    const candidatePath = join(root, "candidate.json");
    await writeFile(exchangePath, `${JSON.stringify(prepared.exchange, null, 2)}\n`);
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
    const evaluated = await evaluateOptimizerCandidate({ exchangePath, candidatePath });
    expect(evaluated.verdict.verdict).toBe("valid");
    const base = await readFile(skillPath, "utf8");
    const expected = base.replace(validEdit.before, validEdit.after);
    expect(evaluated.verdict.candidate_sha256).toBe(sha256(expected));
    expect(evaluated.candidateText).toBe(expected);
  });

  it("rejects lost anchors, wrong base digests, and exchange mismatches", async () => {
    const root = await workspace();
    const store = join(root, "runs");
    await failedRunStore(store);
    const prepared = await prepareOptimizerExchange({ skillPath, store });
    const exchangePath = join(root, "exchange.json");
    await writeFile(exchangePath, `${JSON.stringify(prepared.exchange, null, 2)}\n`);

    const writeAndEvaluate = async (candidate: OptimizerCandidate) => {
      const candidatePath = join(root, `candidate-${randomUUID().slice(0, 8)}.json`);
      await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
      return evaluateOptimizerCandidate({ exchangePath, candidatePath });
    };

    const lostAnchor = await writeAndEvaluate(
      candidateFor(prepared.exchange, [{ anchor: "missing", before: "text that is nowhere", after: "x" }]),
    );
    expect(lostAnchor.verdict.verdict).toBe("invalid");
    expect(lostAnchor.verdict.checks.find((entry) => entry.id === "anchors")?.pass).toBe(false);

    const badBase = await writeAndEvaluate(candidateFor(prepared.exchange, [validEdit], { base_sha256: "a".repeat(64) }));
    expect(badBase.verdict.verdict).toBe("invalid");

    const badExchange = await writeAndEvaluate(
      candidateFor(prepared.exchange, [validEdit], { exchange_id: "opt-other" }),
    );
    expect(badExchange.verdict.verdict).toBe("invalid");
  });

  it("rejects secret material in the candidate before any check runs", async () => {
    const root = await workspace();
    const store = join(root, "runs");
    await failedRunStore(store);
    const prepared = await prepareOptimizerExchange({ skillPath, store });
    const exchangePath = join(root, "exchange.json");
    const candidatePath = join(root, "candidate.json");
    await writeFile(exchangePath, `${JSON.stringify(prepared.exchange, null, 2)}\n`);
    const candidate = candidateFor(prepared.exchange, [validEdit], {
      statement: "token ghp_1234567890abcdefghij",
    });
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
    await expect(evaluateOptimizerCandidate({ exchangePath, candidatePath })).rejects.toMatchObject({
      code: "SECRET_DETECTED",
    });
  });

  it("exposes prepare and evaluate through the CLI", async () => {
    const root = await workspace();
    const store = join(root, "runs");
    await failedRunStore(store);
    const noop = { stdout: (): void => undefined, stderr: (): void => undefined };
    const preparedOutput: string[] = [];
    expect(
      await runCli(["optimize", "prepare", "--skill", skillPath, "--store", store], {
        ...noop, stdout: (text) => { preparedOutput.push(text); },
      }),
    ).toBe(0);
    const { exchange_path: exchangePath } = JSON.parse(preparedOutput.join("")) as { exchange_path: string };
    const exchange = JSON.parse(await readFile(join(repoRoot, exchangePath), "utf8")) as OptimizerExchange;
    const candidatePath = join(root, "candidate.json");
    await writeFile(
      candidatePath,
      `${JSON.stringify(candidateFor(exchange, [validEdit]), null, 2)}\n`,
    );
    expect(
      await runCli(
        ["optimize", "evaluate", "--exchange", exchangePath, "--candidate", candidatePath, "--output", join(root, "adapter-verdict.json")],
        noop,
      ),
    ).toBe(0);
    const verdict = JSON.parse(await readFile(join(root, "adapter-verdict.json"), "utf8")) as {
      verdict: string;
    };
    expect(verdict.verdict).toBe("valid");
  });

  describe("confined candidate staging", () => {
    let root: string;
    let exchange: OptimizerExchange;
    let exchangePath: string;
    let candidatePath: string;
    let candidateOut: string;
    let basePath: string;
    const baseText = `${validEdit.before}\n`;

    beforeEach(async () => {
      root = await realpath(await workspace());
      vi.spyOn(process, "cwd").mockReturnValue(root);
      basePath = join(root, "SKILL.md");
      await writeFile(basePath, baseText);
      await mkdir(join(root, "runs"));
      exchange = (await prepareOptimizerExchange({ skillPath: basePath, store: "runs" })).exchange;
      exchangePath = join(root, "exchange.json");
      candidatePath = join(root, "candidate.json");
      candidateOut = join(root, ".dal", "candidates", "review.md");
      await writeFile(exchangePath, JSON.stringify(exchange));
      await writeFile(candidatePath, JSON.stringify(candidateFor(exchange, [validEdit])));
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([false, true])("preserves an existing verdict and stages nothing (rejected candidate: %s)", async (rejected) => {
      if (rejected) {
        await writeFile(candidatePath, JSON.stringify(candidateFor(exchange, [validEdit], { exchange_id: "opt-other" })));
      }
      const verdictPath = join(root, "existing-verdict.json");
      const original = Buffer.from("{\"verdict\":\"previous evaluation\"}\n");
      await writeFile(verdictPath, original);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli([
        "optimize", "evaluate", "--exchange", exchangePath, "--candidate", candidatePath,
        "--output", verdictPath, "--candidate-out", candidateOut,
      ], { stdout: (text) => { stdout.push(text); }, stderr: (text) => { stderr.push(text); } });
      expect(code).not.toBe(0);
      expect(stderr.join(" ")).toContain("OPTIMIZE_OUTPUT_CONFLICT");
      expect(stdout).toEqual([]);
      expect(await readFile(verdictPath)).toEqual(original);
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(root, ".dal", "candidates"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(basePath, "utf8")).toBe(baseText);
    });

    async function evaluateCli(output = candidateOut): Promise<{ code: number; errors: string[] }> {
      const errors: string[] = [];
      const code = await runCli([
        "optimize", "evaluate", "--exchange", exchangePath, "--candidate", candidatePath,
        "--output", join(root, `verdict-${randomUUID()}.json`), "--candidate-out", output,
      ], { stdout: () => undefined, stderr: (text) => { errors.push(text); } });
      return { code, errors };
    }

    it("stages raw Markdown with the validated digest and preserves existing destinations", async () => {
      const evaluated = await evaluateOptimizerCandidate({ exchangePath, candidatePath });
      expect((await evaluateCli()).code).toBe(0);
      const raw = await readFile(candidateOut);
      expect(raw.toString("utf8")).toBe(baseText.replace(validEdit.before, validEdit.after));
      expect(raw.toString("utf8")).toBe(evaluated.candidateText);
      expect(sha256(raw)).toBe(evaluated.verdict.candidate_sha256);
      expect((await lstat(candidateOut)).mode & 0o777).toBe(0o600);
      await writeFile(candidateOut, "existing review\n");
      const retry = await evaluateCli();
      expect(retry.code).not.toBe(0);
      expect(retry.errors.join(" ")).toContain("OPTIMIZE_STAGING_CONFLICT");
      expect(await readFile(candidateOut, "utf8")).toBe("existing review\n");
      expect(await readFile(basePath, "utf8")).toBe(baseText);
    });

    it.each([
      { target_uri: "repo://other.md" },
      { base_sha256: "a".repeat(64) },
      { exchange_id: "opt-other" },
      { edits: [{ anchor: "same", before: validEdit.before, after: validEdit.before }] },
      { edits: [{ anchor: "missing", before: "missing text", after: "replacement" }] },
    ] satisfies Partial<OptimizerCandidate>[])("rejects without returning or writing candidate text: %j", async (overrides) => {
      await writeFile(candidatePath, JSON.stringify(candidateFor(exchange, [validEdit], overrides)));
      const evaluated = await evaluateOptimizerCandidate({ exchangePath, candidatePath });
      expect(evaluated.verdict.verdict).toBe("invalid");
      expect(evaluated.candidateText).toBeNull();
      expect((await evaluateCli()).code).not.toBe(0);
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(basePath, "utf8")).toBe(baseText);
    });

    it.each(["SKILL.md", "outside.md", ".dal/candidates/nested/review.md", ".dal/candidates/../../outside.md"])(
      "rejects live, outside, or nested destinations: %s", async (output) => {
        const result = await evaluateCli(output);
        expect(result.code).not.toBe(0);
        expect(result.errors.join(" ")).toContain("OPTIMIZE_STAGING_PATH_DENIED");
        expect(await readFile(basePath, "utf8")).toBe(baseText);
        await expect(lstat(join(root, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("rejects invalid surfaces without output", async () => {
      await writeFile(candidatePath, JSON.stringify({ ...candidateFor(exchange, [validEdit]), surface: "prompt" }));
      expect((await evaluateCli()).code).not.toBe(0);
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects symlinked staging roots", async () => {
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, ".dal", "candidates"));
      expect((await evaluateCli()).errors.join(" ")).toContain("OPTIMIZE_STAGING_PATH_DENIED");
      await expect(lstat(join(outside, "review.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a symlinked .dal ancestor", async () => {
      const alternate = join(root, "alternate");
      await mkdir(alternate);
      await writeFile(join(alternate, "SKILL.md"), baseText);
      await symlink(join(root, ".dal"), join(alternate, ".dal"));
      vi.mocked(process.cwd).mockReturnValue(alternate);
      const result = await evaluateCli(".dal/candidates/review.md");
      expect(result.errors.join(" ")).toContain("OPTIMIZE_STAGING_PATH_DENIED");
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each([false, true])("preserves destination symlinks (dangling: %s)", async (dangling) => {
      await mkdir(join(root, ".dal", "candidates"));
      const target = dangling ? join(root, "absent.md") : basePath;
      await symlink(target, candidateOut);
      expect((await evaluateCli()).errors.join(" ")).toContain("OPTIMIZE_STAGING_CONFLICT");
      expect((await lstat(candidateOut)).isSymbolicLink()).toBe(true);
      expect(await readFile(basePath, "utf8")).toBe(baseText);
      if (dangling) await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects on-disk drift before reconstructing even when the anchors still resolve", async () => {
      await writeFile(basePath, `${baseText}changed on disk\n`);
      const evaluated = await evaluateOptimizerCandidate({ exchangePath, candidatePath });
      expect(evaluated.verdict.verdict).toBe("invalid");
      expect(evaluated.verdict.checks).toContainEqual(expect.objectContaining({ id: "base-content-digest", pass: false }));
      expect(evaluated.verdict.checks.some((entry) => entry.id === "anchors")).toBe(false);
      expect(evaluated.verdict.candidate_sha256).toBeNull();
      expect(evaluated.candidateText).toBeNull();
      expect((await evaluateCli()).code).not.toBe(0);
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("hashes actual bytes rather than lossy UTF-8 decoding", async () => {
      const original = Buffer.concat([Buffer.from(baseText), Buffer.from([0xff])]);
      await writeFile(basePath, original);
      exchange = (await prepareOptimizerExchange({ skillPath: basePath, store: "runs" })).exchange;
      expect(exchange.target.base_sha256).toBe(sha256(original));
      await writeFile(exchangePath, JSON.stringify(exchange));
      await writeFile(candidatePath, JSON.stringify(candidateFor(exchange, [validEdit])));
      const drifted = Buffer.concat([Buffer.from(baseText), Buffer.from([0xfe])]);
      expect(drifted.toString("utf8")).toBe(original.toString("utf8"));
      await writeFile(basePath, drifted);
      expect((await evaluateCli()).code).not.toBe(0);
      await expect(lstat(candidateOut)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
