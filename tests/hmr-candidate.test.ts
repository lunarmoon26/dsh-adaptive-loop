import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import {
  CandidateCoordinator,
  CandidateError,
  type Config,
} from "../plugins/dal-hmr-candidate/src/index.js";
import { RunSessionRecorder } from "../plugins/dal-run-record/src/index.js";
import { sha256 } from "../src/json.js";
import { assertSchema, SCHEMA_IDS } from "../src/schema.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const dalCli = join(repositoryRoot, "src", "cli.ts");
const scope = "prop-hmr-candidate-test";
const execFile = promisify(execFileCallback);

interface Fixture {
  root: string;
  entry: string;
  stagedEntry: string;
  approvalFile: string;
}

async function fixture(source = "export const generation = 0;\n"): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "dal-hmr-candidate-"));
  const repository = join(parent, "repository");
  const root = join(parent, "worktree");
  await execFile("git", ["init", repository]);
  const repositoryEntry = join(repository, "plugins", "target", "index.mjs");
  await mkdir(dirname(repositoryEntry), { recursive: true });
  await writeFile(repositoryEntry, source, "utf8");
  await writeFile(join(repository, "package.json"), `${JSON.stringify({
    private: true,
    scripts: {
      dal: `node ${JSON.stringify(tsxCli)} ${JSON.stringify(dalCli)}`,
    },
  }, null, 2)}\n`, "utf8");
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", [
    "-c",
    "user.name=DAL Test",
    "-c",
    "user.email=dal-test@example.invalid",
    "-C",
    repository,
    "commit",
    "-m",
    "fixture",
  ]);
  await execFile("git", ["-C", repository, "worktree", "add", "-b", "candidate", root]);
  const entry = join(root, "plugins", "target", "index.mjs");
  const stagedEntry = join(root, ".dal", "hmr-candidate", "plugins", "target", "index.mjs");
  const approvalFile = join(root, ".dal", "outbox", "candidate-approval.json");
  return { root, entry, stagedEntry, approvalFile };
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    workspaceRoot: root,
    entry: "plugins/target/index.mjs",
    files: ["plugins/target/index.mjs"],
    approvalFile: ".dal/outbox/candidate-approval.json",
    approvalScope: scope,
    approvalCommand: [tsxCli, dalCli],
    dshVersion: "0.1.1-rc.2",
    profile: "hmr-test",
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function writeApproval(path: string, candidateSha256: string): Promise<void> {
  const now = Date.now();
  const decision = {
    $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
    schema_version: "1.0.0",
    decision_id: "dec-hmr-candidate-test",
    request_id: "req-hmr-candidate-test",
    action: "apply_optimization_candidate",
    scope: {
      kind: "proposal",
      value: scope,
      sha256: sha256(scope),
    },
    decision: "approved",
    reviewer: { kind: "human", id: "maintainer-test" },
    decided_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    rationale: "Authorize this exact temporary candidate for the isolated HMR test.",
    evidence: ["repo://tests/hmr-candidate.test.ts"],
    candidate_sha256: candidateSha256,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

function emitReload(ctx: Context, filename: string): void {
  (ctx as unknown as { emit(name: string, reloads: Map<unknown, { filename: string }>): void }).emit(
    "hmr/reload",
    new Map([[() => undefined, { filename: pathToFileURL(filename).href }]]),
  );
}

async function eventually(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function session(id: string, cwd: string): { id: string; header: { createdAt: number; cwd: string } } {
  return { id, header: { createdAt: Date.now() - 100, cwd } };
}

function event(type: string, seq: number, data: Record<string, unknown> = {}): {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
} {
  return { seq, time: Date.now(), type, data };
}

describe("HMR candidate coordinator", () => {
  it("verifies, admits, attributes only a stable fresh session, and restores the baseline", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      const prepared = await coordinator.prepare("cand-hmr-generation-001");
      expect(prepared.sourceSha256).toBe(prepared.stagedSha256);
      expect(prepared.stagingRoot).toBe(".dal/hmr-candidate");

      await writeFile(paths.stagedEntry, "export const generation = 1;\n", "utf8");
      const staged = await coordinator.status();
      expect(staged.stagedSha256).not.toBe(staged.sourceSha256);
      await writeApproval(paths.approvalFile, staged.stagedSha256!);
      const workspaceScriptMarker = join(paths.root, "workspace-approval-script-ran");
      await writeFile(join(paths.root, "package.json"), `${JSON.stringify({
        private: true,
        scripts: { dal: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(workspaceScriptMarker)}, "ran")'` },
      }, null, 2)}\n`, "utf8");

      const applying = coordinator.applyPrepared();
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 1"),
        "candidate bytes were not published",
      );
      emitReload(ctx, paths.entry);
      const admitted = await applying;
      expect(admitted).toMatchObject({
        candidateId: "cand-hmr-generation-001",
        candidateSha256: staged.stagedSha256,
        hmrSequence: 1,
        admitted: true,
      });
      await expect(readFile(workspaceScriptMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const recorder = new RunSessionRecorder(
        { storeRoot: ".dal/runs", maxErrorFacts: 64 },
        undefined,
        () => coordinator.currentGeneration(),
      );
      const eligibleSession = session("candidate-eligible", paths.root);
      recorder.create(eligibleSession);
      recorder.onEvent(eligibleSession, event("turn/start", 0, { turn: 1 }));
      recorder.onEvent(eligibleSession, event("turn/end", 1, { reason: { kind: "completed" } }));
      await recorder.dispose(eligibleSession);
      const eligibleRecord = JSON.parse(
        await readFile(join(paths.root, ".dal", "runs", "run-candidate-eligible-s1.final.json"), "utf8"),
      ) as { context: { candidate_generation: Record<string, unknown> } };
      await expect(assertSchema(SCHEMA_IDS.runRecord, eligibleRecord, "Run record")).resolves.toBeUndefined();
      expect(eligibleRecord.context.candidate_generation).toMatchObject({
        candidate_id: "cand-hmr-generation-001",
        candidate_sha256: staged.stagedSha256,
        start_hmr_sequence: 1,
        end_hmr_sequence: 1,
        evaluation_eligible: true,
        dsh_version: "0.1.1-rc.2",
        profile: "hmr-test",
      });
      expect(eligibleRecord.context.candidate_generation.git_tree).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

      const spanningSession = session("candidate-spanning", paths.root);
      recorder.create(spanningSession);
      recorder.onEvent(spanningSession, event("turn/start", 0, { turn: 1 }));
      emitReload(ctx, join(paths.root, "plugins", "other.mjs"));
      recorder.onEvent(spanningSession, event("turn/end", 1, { reason: { kind: "completed" } }));
      await recorder.dispose(spanningSession);
      const spanningRecord = JSON.parse(
        await readFile(join(paths.root, ".dal", "runs", "run-candidate-spanning-s1.final.json"), "utf8"),
      ) as { context: { candidate_generation: Record<string, unknown> } };
      expect(spanningRecord.context.candidate_generation).toMatchObject({
        start_hmr_sequence: 1,
        end_hmr_sequence: 2,
        evaluation_eligible: false,
      });

      const rejecting = coordinator.reject();
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 0"),
        "baseline bytes were not restored",
      );
      emitReload(ctx, paths.entry);
      await expect(rejecting).resolves.toMatchObject({
        candidateId: null,
        candidateSha256: prepared.sourceSha256,
        hmrSequence: 3,
        admitted: false,
      });
    } finally {
      await ctx.fiber.dispose();
    }
  }, 15_000);

  it("restores the baseline when no successful matching HMR reload admits the candidate", async () => {
    const paths = await fixture();
    await mkdir(dirname(paths.approvalFile), { recursive: true });
    await writeFile(paths.approvalFile, "test-only verifier input\n", "utf8");
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(
        ctx,
        config(paths.root, { timeoutMs: 150 }),
        async () => undefined,
      );
      const baseline = await coordinator.prepare("cand-hmr-failure-001");
      await writeFile(paths.stagedEntry, "export const generation = 2;\n", "utf8");

      const result = coordinator.applyPrepared().catch((error: unknown) => error);
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 2"),
        "candidate bytes were not published",
      );
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 0"),
        "failed candidate did not restore baseline bytes",
      );
      emitReload(ctx, paths.entry);

      const error = await result;
      expect(error).toBeInstanceOf(CandidateError);
      expect((error as CandidateError).code).toBe("CANDIDATE_NOT_ADMITTED");
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 0;\n");
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        candidateSha256: baseline.sourceSha256,
        admitted: false,
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("aborts pending admission on an unrelated successful reload", async () => {
    const paths = await fixture();
    await mkdir(dirname(paths.approvalFile), { recursive: true });
    await writeFile(paths.approvalFile, "test-only verifier input\n", "utf8");
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root), async () => undefined);
      const baseline = await coordinator.prepare("cand-hmr-unrelated-001");
      await writeFile(paths.stagedEntry, "export const generation = 4;\n", "utf8");

      const result = coordinator.applyPrepared().catch((error: unknown) => error);
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 4"),
        "candidate bytes were not published",
      );
      emitReload(ctx, join(paths.root, "plugins", "other.mjs"));
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 0"),
        "unrelated reload did not trigger baseline restoration",
      );
      emitReload(ctx, paths.entry);

      await expect(result).resolves.toMatchObject({ code: "CANDIDATE_NOT_ADMITTED" });
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        candidateSha256: baseline.sourceSha256,
        admitted: false,
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("aborts pending admission when the configured entry reloads with another digest", async () => {
    const paths = await fixture();
    await mkdir(dirname(paths.approvalFile), { recursive: true });
    await writeFile(paths.approvalFile, "test-only verifier input\n", "utf8");
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root), async () => undefined);
      const baseline = await coordinator.prepare("cand-hmr-digest-mismatch-001");
      await writeFile(paths.stagedEntry, "export const generation = 6;\n", "utf8");

      const result = coordinator.applyPrepared().catch((error: unknown) => error);
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 6"),
        "candidate bytes were not published",
      );
      await writeFile(paths.entry, "export const generation = 99;\n", "utf8");
      emitReload(ctx, paths.entry);
      await eventually(
        async () => (await readFile(paths.entry, "utf8")).includes("generation = 0"),
        "digest mismatch did not trigger baseline restoration",
      );
      emitReload(ctx, paths.entry);

      await expect(result).resolves.toMatchObject({ code: "CANDIDATE_NOT_ADMITTED" });
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        candidateSha256: baseline.sourceSha256,
        admitted: false,
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("publishes no live bytes when exact candidate approval is denied", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      const baseline = await readFile(paths.entry, "utf8");
      await coordinator.prepare("cand-hmr-denied-001");
      await writeFile(paths.stagedEntry, "export const generation = 3;\n", "utf8");
      await writeApproval(paths.approvalFile, "a".repeat(64));

      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_APPROVAL_DENIED",
      });
      expect(await readFile(paths.entry, "utf8")).toBe(baseline);
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        hmrSequence: 0,
        admitted: false,
      });
    } finally {
      await ctx.fiber.dispose();
    }
  }, 15_000);

  it("refuses to overwrite live files that drift after staging", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root), async () => undefined);
      await coordinator.prepare("cand-hmr-drift-001");
      await writeFile(paths.stagedEntry, "export const generation = 4;\n", "utf8");
      await writeFile(paths.entry, "export const generation = 99;\n", "utf8");

      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_BASELINE_DRIFT",
      });
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 99;\n");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("rejects a forged linked-worktree marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-hmr-forged-worktree-"));
    await writeFile(join(root, ".git"), "gitdir: /tmp/not-a-real-worktree\n", "utf8");
    const entry = join(root, "plugins", "target", "index.mjs");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "export const generation = 0;\n", "utf8");
    const ctx = new Context();
    try {
      await expect(CandidateCoordinator.create(ctx, config(root), async () => undefined)).rejects.toMatchObject({
        code: "CANDIDATE_WORKTREE_REQUIRED",
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("rejects an approval command sourced from the candidate worktree", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      await expect(CandidateCoordinator.create(
        ctx,
        config(paths.root, { approvalCommand: [join(paths.root, "package.json")] }),
        async () => undefined,
      )).rejects.toMatchObject({ code: "CANDIDATE_CONFIG_INVALID" });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("refuses application when a pinned approval launcher changes", async () => {
    const paths = await fixture();
    const launcher = join(dirname(paths.root), "approval-launcher.mjs");
    await writeFile(launcher, "export {};\n", "utf8");
    await mkdir(dirname(paths.approvalFile), { recursive: true });
    await writeFile(paths.approvalFile, "test-only verifier input\n", "utf8");
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(
        ctx,
        config(paths.root, { approvalCommand: [launcher] }),
        async () => undefined,
      );
      await coordinator.prepare("cand-hmr-launcher-drift-001");
      await writeFile(paths.stagedEntry, "export const generation = 5;\n", "utf8");
      await writeFile(launcher, "export const changed = true;\n", "utf8");

      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_APPROVAL_COMMAND_DRIFT",
      });
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 0;\n");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("rechecks approval launcher digests after the verifier returns", async () => {
    const paths = await fixture();
    const launcher = join(dirname(paths.root), "approval-launcher.mjs");
    await writeFile(launcher, "export {};\n", "utf8");
    await mkdir(dirname(paths.approvalFile), { recursive: true });
    await writeFile(paths.approvalFile, "test-only verifier input\n", "utf8");
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(
        ctx,
        config(paths.root, { approvalCommand: [launcher] }),
        async () => {
          await writeFile(launcher, "export const changed = true;\n", "utf8");
        },
      );
      await coordinator.prepare("cand-hmr-launcher-race-001");
      await writeFile(paths.stagedEntry, "export const generation = 7;\n", "utf8");

      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_APPROVAL_COMMAND_DRIFT",
      });
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 0;\n");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it.skipIf(process.env.DAL_DSH_HMR_CHECKOUT === undefined)(
    "composes with the pinned DSH Loader and HMR implementation",
    async () => {
      const dshRoot = resolve(process.env.DAL_DSH_HMR_CHECKOUT!);
      const baselineSource = `
export const name = "dal-real-hmr-target";
export function apply(ctx) {
  globalThis.__dalHmrCandidateTestGeneration = 0;
  ctx.effect(() => () => {
    if (globalThis.__dalHmrCandidateTestGeneration === 0) globalThis.__dalHmrCandidateTestGeneration = -1;
  });
}
`;
      const candidateSource = baselineSource
        .replace("Generation = 0", "Generation = 1")
        .replace("Generation === 0", "Generation === 1");
      const paths = await fixture(baselineSource);
      await mkdir(dirname(paths.approvalFile), { recursive: true });
      await writeFile(paths.approvalFile, "composition-probe approval stub\n", "utf8");

      const { default: Loader } = await import(pathToFileURL(join(dshRoot, "vendor", "loader", "lib", "index.js")).href);
      const { default: Timer } = await import(pathToFileURL(join(dshRoot, "vendor", "timer", "lib", "index.js")).href);
      const { default: Hmr } = await import(pathToFileURL(join(dshRoot, "vendor", "hmr", "lib", "index.js")).href);
      const ctx = new Context();
      try {
        ctx.baseUrl = `${pathToFileURL(paths.root).href}/`;
        await ctx.plugin(Loader);
        await ctx.plugin(Timer);
        await ctx.plugin(Hmr, {
          root: ["."],
          ignored: ["**/node_modules", "**/.*"],
          debounce: 20,
          usePolling: true,
          interval: 50,
        });
        const loader = (ctx as unknown as {
          loader: {
            create(options: { name: string; config: object }): Promise<string>;
            await(): Promise<void>;
          };
        }).loader;
        await loader.create({ name: "./plugins/target/index.mjs", config: {} });
        await loader.await();

        const coordinator = await CandidateCoordinator.create(
          ctx,
          config(paths.root, { timeoutMs: 10_000 }),
          async () => undefined,
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
        const baseline = await coordinator.prepare("cand-real-hmr-001");
        await writeFile(paths.stagedEntry, candidateSource, "utf8");

        const admitted = await coordinator.applyPrepared();
        expect((globalThis as { __dalHmrCandidateTestGeneration?: number }).__dalHmrCandidateTestGeneration).toBe(1);
        expect(admitted).toMatchObject({ candidateId: "cand-real-hmr-001", hmrSequence: 1, admitted: true });

        const restored = await coordinator.reject();
        expect((globalThis as { __dalHmrCandidateTestGeneration?: number }).__dalHmrCandidateTestGeneration).toBe(0);
        expect(restored).toMatchObject({
          candidateId: null,
          candidateSha256: baseline.sourceSha256,
          hmrSequence: 2,
          admitted: false,
        });
      } finally {
        await ctx.fiber.dispose();
        delete (globalThis as { __dalHmrCandidateTestGeneration?: number }).__dalHmrCandidateTestGeneration;
      }
    },
    30_000,
  );
});
