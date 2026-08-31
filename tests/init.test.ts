import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { initWorkspace } from "../src/init.js";

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

describe("workspace initialization", () => {
  it("scaffolds evidence stores, skill, instructions, and gitignore in a fresh workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-init-"));
    const result = await initWorkspace({ dir: root });
    expect(result.status).toBe("initialized");
    for (const directory of [".dal/outbox", ".dal/store", ".dal/runs", ".dal/clusters"]) {
      await access(join(root, directory));
    }
    const skill = await readFile(join(root, ".agents", "skills", "end-task-feedback", "SKILL.md"), "utf8");
    expect(skill).toContain("name: end-task-feedback");
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("dal agent instructions");
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("!.dal/outbox/");
  });

  it("never overwrites existing workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-init-"));
    await writeFile(join(root, "AGENTS.md"), "existing custom instructions\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const result = await initWorkspace({ dir: root });
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("existing custom instructions\n");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(result.skipped).toEqual(expect.arrayContaining(["AGENTS.md", ".gitignore"]));
  });

  it("exposes the init command through the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-init-"));
    const captured = captureIo();
    expect(await runCli(["init", "--dir", root], captured.io)).toBe(0);
    const output = JSON.parse(captured.stdout.join(""));
    expect(output.status).toBe("initialized");
    expect(output.created).toEqual(expect.arrayContaining([".dal/outbox"]));
    expect(output.next_steps.some((step: string) => step.includes("human-performed"))).toBe(true);
  });
});
