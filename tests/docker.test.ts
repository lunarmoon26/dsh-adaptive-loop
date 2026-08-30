import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDockerAvailable, containerPath, dockerAvailable, dockerRunArgv, loadDotEnv, translateCommandForContainer } from "../src/docker.js";
import { runVerifier } from "../src/executor.js";

const repoRoot = resolve(import.meta.dirname, "..");
const verifierAction = resolve(
  repoRoot,
  "benchmarks",
  "tau-style-workflow",
  "dal",
  "fixtures",
  "verifier-grader.json",
);

function stubBinDirectory(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dal-docker-stub-${name}-`));
  const path = join(dir, "docker");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

describe("docker runner primitives", () => {
  it("translates workspace paths into /workspace and refuses escapes", () => {
    const root = join(repoRoot, "benchmarks", "tau-style-workflow");
    expect(containerPath(join(root, "tasks", "task-001-refund.json"), root)).toBe(
      "/workspace/tasks/task-001-refund.json",
    );
    expect(() => containerPath("/etc/passwd", root)).toThrowError(/escapes the workspace mount/);
    expect(() => containerPath(join(repoRoot, "..", "other"), root)).toThrowError(/escapes the workspace mount/);
  });

  it("rewrites workspace-root host paths and leaves container paths untouched", () => {
    const root = repoRoot;
    const translated = translateCommandForContainer(
      `node /opt/dal/node_modules/tsx/dist/cli.mjs ${resolve(root, "benchmarks")}/x.json /tmp/outside.json`,
      root,
    );
    expect(translated).toBe(
      "node /opt/dal/node_modules/tsx/dist/cli.mjs /workspace/benchmarks/x.json /tmp/outside.json",
    );
    const escaped = translateCommandForContainer(`cat ${resolve(repoRoot, "..", "outside.txt")}`, root);
    expect(escaped).toContain("outside.txt");
    expect(escaped).not.toContain("/workspace/");
  });

  it("builds the docker argv with hardcoded isolation flags", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const argv = dockerRunArgv(
        {
          image: "dsh-adaptive-loop/dsh:0.1.1-rc.2",
          runFlags: ["--security-opt", "seccomp=unconfined"],
          envNames: ["DEEPSEEK_API_KEY", "UNSET_VAR"],
          workspaceRoot: repoRoot,
          network: "none",
        },
        ["node", "/opt/dal/dist/cli.js", "--help"],
      );
      expect(argv.slice(0, 6)).toEqual(["run", "--rm", "--network", "none", "--security-opt", "seccomp=unconfined"]);
      expect(argv).toContain("-v");
      expect(argv[argv.indexOf("-v")! + 1]).toBe(`${repoRoot}:/workspace`);
      expect(argv[argv.indexOf("-w")! + 1]).toBe("/workspace");
      expect(argv).toContain("-e");
      expect(argv[argv.indexOf("-e")! + 1]).toBe("DEEPSEEK_API_KEY");
      expect(argv).not.toContain("UNSET_VAR");
      expect(argv[argv.indexOf("dsh-adaptive-loop/dsh:0.1.1-rc.2")! + 1]).toBe("node");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("loads the workspace .env for policy-listed names with host precedence", async () => {
    const root = mkdtempSync(join(tmpdir(), "dal-docker-env-"));
    writeFileSync(
      join(root, ".env"),
      "# comment\nDEEPSEEK_API_KEY=\"dot-value\"\nexport OTHER_KEY='other'\nMALFORMED-LINE\n",
    );
    expect(loadDotEnv(root)).toEqual({ DEEPSEEK_API_KEY: "dot-value", OTHER_KEY: "other" });

    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const argv = dockerRunArgv(
        { image: "img", runFlags: [], envNames: ["DEEPSEEK_API_KEY"], workspaceRoot: root, network: "default" },
        ["true"],
      );
      expect(argv[argv.indexOf("-e")! + 1]).toBe("DEEPSEEK_API_KEY=dot-value");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }

    process.env.DEEPSEEK_API_KEY = "host-value";
    try {
      const argv = dockerRunArgv(
        { image: "img", runFlags: [], envNames: ["DEEPSEEK_API_KEY"], workspaceRoot: root, network: "default" },
        ["true"],
      );
      expect(argv[argv.indexOf("-e")! + 1]).toBe("DEEPSEEK_API_KEY");
      expect(argv).not.toContain("DEEPSEEK_API_KEY=dot-value");
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("reports an unavailable daemon and fails closed at the runner", async () => {
    const stub = stubBinDirectory("down", "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n");
    const previous = process.env.PATH;
    process.env.PATH = `${stub}:${previous ?? ""}`;
    try {
      expect(dockerAvailable()).toBe(false);
      expect(() => assertDockerAvailable()).toThrowError(/docker is not reachable/);
      await expect(
        runVerifier({
          actionPath: verifierAction,
          commandLine: "true",
          workspaceRoot: repoRoot,
          runner: "docker",
          docker: { image: "x", runFlags: [], envNames: [] },
        }),
      ).rejects.toMatchObject({ code: "DOCKER_UNAVAILABLE" });
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe.skipIf(process.env.DAL_DOCKER_PROBE !== "1")("container-hosted verifier (live daemon)", () => {
  it("runs the deterministic grader through the in-container sandbox chain", async () => {
    const task = "/workspace/benchmarks/tau-style-workflow/tasks/task-001-refund.json";
    const state = "/workspace/benchmarks/tau-style-workflow/dal/fixtures/result-pass.json";
    const result = await runVerifier({
      actionPath: verifierAction,
      commandLine: `node /opt/dal/node_modules/tsx/dist/cli.mjs /workspace/benchmarks/tau-style-workflow/grader/grade.ts ${task} ${state}`,
      workspaceRoot: repoRoot,
      runner: "docker",
      docker: { image: "dsh-adaptive-loop/dsh:0.1.1-rc.2", runFlags: ["--security-opt", "seccomp=unconfined"], envNames: [] },
    });
    expect(result.passed).toBe(true);
    expect(["bwrap", "landlock-run"]).toContain(result.sandbox.backend);
    expect(result.sandbox.enforcement).toBe("full");
  });

  it("denies writes outside the declared roots via the in-container dialect", async () => {
    await expect(
      runVerifier({
        actionPath: verifierAction,
        commandLine: "sh -c 'echo x > /home/node/dal-docker-denied.txt'",
        workspaceRoot: repoRoot,
        runner: "docker",
        docker: { image: "dsh-adaptive-loop/dsh:0.1.1-rc.2", runFlags: ["--security-opt", "seccomp=unconfined"], envNames: [] },
      }),
    ).rejects.toMatchObject({ code: "VERIFIER_FAILED" });
  });
});
