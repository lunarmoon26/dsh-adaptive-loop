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
  type Config,
} from "../plugins/dal-hmr-candidate/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const execFile = promisify(execFileCallback);

interface Fixture {
  root: string;
  entry: string;
  stagedEntry: string;
}

async function fixture(source = "export const generation = 0;\n"): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "dal-hmr-candidate-"));
  const repository = join(parent, "repository");
  const root = join(parent, "worktree");
  await execFile("git", ["init", repository]);
  const repositoryEntry = join(repository, "plugins", "target", "index.mjs");
  await mkdir(dirname(repositoryEntry), { recursive: true });
  await writeFile(repositoryEntry, source, "utf8");
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
  return {
    root,
    entry: join(root, "plugins", "target", "index.mjs"),
    stagedEntry: join(root, ".dal", "hmr-candidate", "plugins", "target", "index.mjs"),
  };
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    workspaceRoot: root,
    entry: "plugins/target/index.mjs",
    files: ["plugins/target/index.mjs"],
    dshVersion: "0.1.1-rc.2",
    profile: "hmr-test",
    ...overrides,
  };
}

function emitReload(ctx: Context, filename: string): void {
  (ctx as unknown as { emit(name: string, reloads: Map<unknown, { filename: string }>): void }).emit(
    "hmr/reload",
    new Map([[() => undefined, { filename: pathToFileURL(filename).href }]]),
  );
}

describe("quarantined HMR candidate coordinator", () => {
  it("stages inactive bytes and rejects application before approval verification or a live write", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      const prepared = await coordinator.prepare("cand-hmr-quarantine-001");
      await writeFile(paths.stagedEntry, "export const generation = 1;\n", "utf8");
      const staged = await coordinator.status();
      expect(staged.stagedSha256).not.toBe(prepared.sourceSha256);

      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_ADMISSION_QUARANTINED",
      });
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 0;\n");
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        hmrSequence: 0,
        admitted: false,
      });

      await expect(coordinator.reject()).resolves.toMatchObject({
        candidateId: null,
        admitted: false,
      });
      expect((await coordinator.status()).preparedCandidateId).toBeUndefined();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("records external reload sequence changes without admitting their source bytes", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      await writeFile(paths.entry, "export const generation = 9;\n", "utf8");
      emitReload(ctx, paths.entry);
      expect(coordinator.currentGeneration()).toMatchObject({
        candidateId: null,
        hmrSequence: 1,
        admitted: false,
      });
      await coordinator.prepare("cand-hmr-external-reload-001");
      await writeFile(paths.entry, "export const generation = 10;\n", "utf8");
      await expect(coordinator.reject()).rejects.toMatchObject({
        code: "CANDIDATE_REJECTION_QUARANTINED",
      });
      expect(await readFile(paths.entry, "utf8")).toBe("export const generation = 10;\n");
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
      await expect(CandidateCoordinator.create(ctx, config(root))).rejects.toMatchObject({
        code: "CANDIDATE_WORKTREE_REQUIRED",
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("does not expose an erased-private activation path or mutable generation state", async () => {
    const paths = await fixture();
    const ctx = new Context();
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      const exposed = coordinator as unknown as Record<string, unknown>;
      expect(exposed.activate).toBeUndefined();
      expect(exposed.verifyApproval).toBeUndefined();
      expect(exposed.generation).toBeUndefined();
      expect(exposed.config).toBeUndefined();
      for (const method of ["currentGeneration", "status", "prepare", "applyPrepared", "reject"]) {
        expect(Object.getOwnPropertyDescriptor(coordinator, method)).toMatchObject({
          configurable: false,
          writable: false,
        });
      }
      expect(Reflect.set(coordinator, "currentGeneration", () => ({ admitted: true }))).toBe(false);
      expect(Reflect.set(coordinator, "applyPrepared", async () => ({ admitted: true }))).toBe(false);
      exposed.generation = { admitted: true };
      expect(coordinator.currentGeneration()).toMatchObject({ candidateId: null, admitted: false });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("uses fixed own implementations even when public prototype names were patched", async () => {
    const paths = await fixture();
    const ctx = new Context();
    const prototype = CandidateCoordinator.prototype as unknown as Record<string, unknown>;
    Object.defineProperties(prototype, {
      applyPrepared: { configurable: true, value: async () => ({ admitted: true }) },
      currentGeneration: { configurable: true, value: () => ({ admitted: true }) },
    });
    try {
      const coordinator = await CandidateCoordinator.create(ctx, config(paths.root));
      expect(coordinator.currentGeneration()).toMatchObject({ candidateId: null, admitted: false });
      await expect(coordinator.applyPrepared()).rejects.toMatchObject({
        code: "CANDIDATE_ADMISSION_QUARANTINED",
      });
      expect(Object.getOwnPropertyDescriptor(CandidateCoordinator, "create")).toMatchObject({
        configurable: false,
        writable: false,
      });
    } finally {
      delete prototype.applyPrepared;
      delete prototype.currentGeneration;
      await ctx.fiber.dispose();
    }
  });

  it.skipIf(process.env.DAL_DSH_HMR_CHECKOUT === undefined)(
    "reproduces DSH pre-readiness reload and multi-file imported-closure failures",
    async () => {
      const probe = join(repositoryRoot, "tests", "probes", "dsh-hmr-readiness.mjs");
      const { stdout } = await execFile(process.execPath, [probe, resolve(process.env.DAL_DSH_HMR_CHECKOUT!)]);
      const result = JSON.parse(stdout) as {
        failed_activation: Record<string, unknown>;
        multifile_race: Record<string, unknown>;
      };
      expect(result.failed_activation).toMatchObject({
        hmr_reload_emitted: true,
        phase_at_event: "loading",
        final_phase: "failed",
        baseline_restored: false,
      });
      expect(result.multifile_race).toMatchObject({
        source_at_event: "complete-candidate",
        runtime_after_event: "hybrid",
      });
    },
    30_000,
  );
});
