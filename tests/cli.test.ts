import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, matchesEntryPoint } from "../src/cli.js";

const fixture = (...parts: string[]): string => resolve(import.meta.dirname, "fixtures", ...parts);

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

describe("CLI", () => {
  it("documents policy and evaluation commands plus the non-execution boundary", async () => {
    const captured = captureIo();
    expect(await runCli(["help"], captured.io)).toBe(0);
    expect(captured.stdout.join("")).toContain("dal policy check");
    expect(captured.stdout.join("")).toContain("dal eval run");
    expect(captured.stdout.join("")).toContain("dal reset execute");
    expect(captured.stdout.join("")).toContain("executes a requested action");
  });

  it("recognizes the CLI entry point through a symlinked global bin", () => {
    const entryUrl = "file:///prefix/lib/node_modules/dsh-adaptive-loop/dist/cli.js";
    const entryPath = "/prefix/lib/node_modules/dsh-adaptive-loop/dist/cli.js";
    const realpath = (value: string): string =>
      value === "/prefix/bin/dal" ? entryPath : value;
    expect(matchesEntryPoint(entryPath, entryUrl, realpath)).toBe(true);
    expect(matchesEntryPoint("/prefix/bin/dal", entryUrl, realpath)).toBe(true);
    expect(matchesEntryPoint("/usr/local/bin/other", entryUrl, realpath)).toBe(false);
    expect(matchesEntryPoint(undefined, entryUrl, realpath)).toBe(false);
  });

  it("returns success for a valid feedback fixture", async () => {
    const captured = captureIo();
    expect(await runCli(["feedback", "validate", fixture("feedback", "completed.json")], captured.io)).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "valid" });
  });

  it("reports a secret rule without printing the matched value", async () => {
    const captured = captureIo();
    expect(await runCli(["feedback", "validate", fixture("feedback", "secret.json")], captured.io)).toBe(1);
    const error = captured.stderr.join("");
    expect(error).toContain("SECRET_DETECTED");
    expect(error).toContain("github-token");
    expect(error).not.toContain("ghp_1234567890abcdefghij");
  });

  it("records but returns failure for an unapproved candidate request", async () => {
    const captured = captureIo();
    const store = await mkdtemp(join(tmpdir(), "dal-cli-policy-"));
    expect(
      await runCli(
        ["policy", "check", fixture("guardrail", "unapproved-candidate.json"), "--store", store],
        captured.io,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ effect: "requires_human_approval" });
    expect(captured.stderr.join("")).toContain("POLICY_REJECTED");
  });

  it("rejects improvement output outside policy-owned roots", async () => {
    const captured = captureIo();
    const root = await mkdtemp(join(tmpdir(), "dal-cli-output-"));
    const output = join(root, "proposal.json");
    expect(
      await runCli(
        [
          "improvement",
          "transition",
          fixture("proposals", "observed.json"),
          "--to",
          "normalized",
          "--actor-kind",
          "dsh-agent",
          "--actor-id",
          "agent-local",
          "--evidence",
          "repo://tests/fixtures/feedback/completed.json",
          "--notes",
          "Attempt an outside-root write.",
          "--at",
          "2026-08-27T14:01:00.000Z",
          "--output",
          output,
        ],
        captured.io,
      ),
    ).toBe(1);
    expect(captured.stderr.join("")).toContain("WRITE_PATH_DENIED");
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects improvement output through a symbolic link", async () => {
    const captured = captureIo();
    const target = await mkdtemp(join(tmpdir(), "dal-cli-symlink-target-"));
    const localRoot = resolve(import.meta.dirname, "..", ".dal", "proposals");
    const link = join(localRoot, "test-output-link.json");
    await mkdir(localRoot, { recursive: true });
    await symlink(join(target, "proposal.json"), link, "file").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    expect(
      await runCli(
        [
          "improvement",
          "transition",
          fixture("proposals", "observed.json"),
          "--to",
          "normalized",
          "--actor-kind",
          "dsh-agent",
          "--actor-id",
          "agent-local",
          "--evidence",
          "repo://tests/fixtures/feedback/completed.json",
          "--notes",
          "Attempt a symlink traversal.",
          "--at",
          "2026-08-27T14:01:00.000Z",
          "--output",
          ".dal/proposals/test-output-link.json",
        ],
        captured.io,
      ),
    ).toBe(1);
    expect(captured.stderr.join("")).toContain("WRITE_PATH_DENIED");
    await expect(access(join(target, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a new proposal state exclusively and never overwrites it", async () => {
    const identifier = randomUUID();
    const output = `.dal/proposals/normalized-${identifier}.json`;
    const input = fixture("proposals", "observed.json");
    const beforeInput = await readFile(input);
    const argumentsForTransition = [
      "improvement",
      "transition",
      input,
      "--to",
      "normalized",
      "--actor-kind",
      "dsh-agent",
      "--actor-id",
      "agent-local",
      "--evidence",
      "repo://tests/fixtures/feedback/completed.json",
      "--notes",
      "Record an immutable normalized state.",
      "--at",
      "2026-08-27T14:01:00.000Z",
      "--output",
      output,
    ];
    const first = captureIo();
    expect(await runCli(argumentsForTransition, first.io)).toBe(0);
    const outputPath = resolve(import.meta.dirname, "..", output);
    const firstContent = await readFile(outputPath);
    const second = captureIo();
    expect(await runCli(argumentsForTransition, second.io)).toBe(1);

    expect(second.stderr.join("")).toContain("PROPOSAL_OUTPUT_CONFLICT");
    expect(await readFile(outputPath)).toEqual(firstContent);
    expect(await readFile(input)).toEqual(beforeInput);
  });
});
