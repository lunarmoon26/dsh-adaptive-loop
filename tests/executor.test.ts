import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SandboxPolicy } from "@deepseek-ai/dsh-sandbox";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { runVerifier } from "../src/executor.js";
import { confine } from "../src/sandbox-backend.js";

const repoRoot = resolve(import.meta.dirname, "..");
const workspace = resolve(repoRoot, "benchmarks", "tau-style-workflow");
const fixture = (...parts: string[]): string => resolve(workspace, ...parts);
const verifierAction = fixture("dal", "fixtures", "verifier-grader.json");

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

const passthroughConfine = async (argv: string[]) => ({
  argv,
  backend: "fake",
  enforcement: "full" as const,
  denialSignatures: [] as string[],
  runnerFailureRules: [],
});

describe("confined verifier executor (dsh sandbox seam)", () => {
  it.skipIf(process.env.DAL_SANDBOX_PROBE !== "1")("runs the deterministic grader through the seam backend", async () => {
    const taskPath = fixture("tasks", "task-001-refund.json");
    const statePath = fixture("dal", "fixtures", "result-pass.json");
    const result = await runVerifier({
      actionPath: verifierAction,
      commandLine: `pnpm exec tsx ${fixture("grader", "grade.ts")} ${taskPath} ${statePath}`,
      workspaceRoot: repoRoot,
    });
    expect(result.passed).toBe(true);
    expect(result.sandbox.enforcement).toBe("full");
    expect(["sandbox-exec", "bwrap", "landlock-run"]).toContain(result.sandbox.backend);
  });

  it.skipIf(process.env.DAL_SANDBOX_PROBE !== "1")("denies writes outside the declared roots via the backend dialect", async () => {
    const outside = join(homedir(), `dal-exec-denied-${Date.now()}.txt`);
    const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: repoRoot };
    const confinement = await confine(["sh", "-c", "true"], policy);
    const result = await runVerifier({
      actionPath: verifierAction,
      commandLine: `sh -c 'echo x > ${outside}'`,
      workspaceRoot: repoRoot,
    });
    expect(result.passed).toBe(false);
    const lower = result.stderr.toLowerCase();
    expect(confinement.denialSignatures.some((signature) => lower.includes(signature.toLowerCase()))).toBe(true);
  });

  it("fails closed when the backend reports the sandbox unavailable", async () => {
    await expect(
      runVerifier({
        actionPath: verifierAction,
        commandLine: "sh -c true",
        workspaceRoot: repoRoot,
        confineFn: async () => {
          const { DalError } = await import("../src/errors.js");
          throw new DalError("SANDBOX_UNAVAILABLE", "no usable backend");
        },
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });

  it("refuses unconfined execution and wrong capabilities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dal-exec-actions-"));
    const read = (await import("node:fs/promises")).readFile;
    const base = JSON.parse(await read(verifierAction, "utf8"));

    const noSandbox = JSON.parse(JSON.stringify(base));
    noSandbox.sandbox.mode = "none";
    const noSandboxPath = join(dir, "no-sandbox.json");
    await writeFile(noSandboxPath, `${JSON.stringify(noSandbox, null, 2)}\n`, "utf8");
    await expect(
      runVerifier({ actionPath: noSandboxPath, commandLine: "sh -c true", workspaceRoot: repoRoot, confineFn: passthroughConfine }),
    ).rejects.toMatchObject({ code: "VERIFIER_DENIED" });

    const networkAction = JSON.parse(JSON.stringify(base));
    networkAction.sandbox.network = "allowlisted";
    const networkPath = join(dir, "network.json");
    await writeFile(networkPath, `${JSON.stringify(networkAction, null, 2)}\n`, "utf8");
    await expect(
      runVerifier({ actionPath: networkPath, commandLine: "sh -c true", workspaceRoot: repoRoot, confineFn: passthroughConfine }),
    ).rejects.toMatchObject({ code: "VERIFIER_DENIED" });
  });

  it.skipIf(process.env.DAL_SANDBOX_PROBE !== "1")("exposes the executor through the CLI", async () => {
    const taskPath = fixture("tasks", "task-001-refund.json");
    const statePath = fixture("dal", "fixtures", "result-pass.json");
    const captured = captureIo();
    expect(
      await runCli(
        ["verify", "run", "--action", verifierAction, "--command", `pnpm exec tsx ${fixture("grader", "grade.ts")} ${taskPath} ${statePath}`, "--workspace", repoRoot],
        captured.io,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "passed" });
  });
});
