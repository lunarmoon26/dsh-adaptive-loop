import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectedSkillArtifact } from "../benchmarks/tau-style-workflow/run-e2e.js";
import { stageCandidateWorkspace } from "../benchmarks/tau-style-workflow/e2e-topology.js";
import { sha256 } from "../src/json.js";

const root = resolve(import.meta.dirname, "..");
let directory: string;
beforeEach(async () => {
  await mkdir(join(root, ".dal/check"), { recursive: true });
  directory = await mkdtemp(join(root, ".dal/check/skill-artifact-test-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("selected skill artifact", () => {
  it("keeps the existing reference as the default", async () => {
    const selected = await selectedSkillArtifact(new Map());
    expect(selected.uri).toBe("repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md");
    expect(selected.sha256).toBe(sha256(await readFile(selected.path)));
  });
  it("stages exactly the selected UTF-8 bytes without changing the baseline", async () => {
    const baseline = await selectedSkillArtifact(new Map());
    const path = join(directory, "candidate.md");
    const bytes = Buffer.from("\ufeff# Candidate\r\nKeep one idempotency key.\r\n");
    await writeFile(path, bytes);
    const selected = await selectedSkillArtifact(new Map([["skill", relative(root, path)]]));
    expect(selected.sha256).toBe(sha256(bytes));
    expect(selected.size_bytes).toBe(bytes.byteLength);
    expect(selected.uri).toBe(`repo://${relative(root, path)}`);
    const staged = join(directory, "stage");
    await stageCandidateWorkspace({ stageRoot: staged, taskId: "task.json", agentTask: { instruction: "task" }, compositionPatch: "[]\n", skillPath: selected.path,
      policyPath: join(root, "benchmarks/tau-style-workflow/tasks/policy.md") });
    expect(await readFile(join(staged, ".agents/skills/refund-workflow/SKILL.md"))).toEqual(bytes);
    expect((await selectedSkillArtifact(new Map())).sha256).toBe(baseline.sha256);
    await writeFile(path, "# Changed candidate\n");
    expect((await selectedSkillArtifact(new Map([["skill", path]]))).sha256).not.toBe(selected.sha256);
  });
  it.each(["symlink", "ancestor", "outside", "extension", "oversize", "utf8", "secret"])("rejects unsafe artifact %s", async kind => {
    let path = join(directory, "candidate.md");
    await writeFile(path, "# Candidate\n");
    if (kind === "symlink") { const link = join(directory, "link.md"); await symlink(path, link); path = link; }
    if (kind === "ancestor") { const link = join(directory, "alias"); await symlink(await realpath(directory), link); path = join(link, "candidate.md"); }
    if (kind === "outside") path = "/tmp/outside.md";
    if (kind === "extension") path = join(root, ".env");
    if (kind === "oversize") await writeFile(path, "a".repeat(65537));
    if (kind === "utf8") await writeFile(path, Buffer.from([0xff]));
    if (kind === "secret") await writeFile(path, "ghp_1234567890abcdefghij1234567890");
    await expect(selectedSkillArtifact(new Map([["skill", path]]))).rejects.toThrow();
  });
});
