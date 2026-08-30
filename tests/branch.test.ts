import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { branchStats, evaluateBranch, recordBranch, selectBranchUcb } from "../src/branch.js";
import { runCli } from "../src/cli.js";

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

async function writeDraft(path: string, surface = "skills"): Promise<void> {
  const draft = {
    $schema: "https://recursive-dev-loop.dev/schemas/proposal-draft.v1.schema.json",
    schema_version: "1.0.0",
    draft_id: `drf-${surface}-fixture`,
    created_at: "2026-08-29T19:00:00.000Z",
    payload_sha256: "a".repeat(64),
    model: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    surface,
    target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
    base_sha256: "b".repeat(64),
    title: "Fixture draft",
    objective: "Exercise the branch ledger.",
    statement: "Raises task_success_rate by at least 0.1.",
    improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }],
    regressions: [],
    provenance: { runner: "injected", clusters: [] },
  };
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
}

describe("bounded search branches", () => {
  it("records branches with parent linkage and validates the draft", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-branch-"));
    const draftPath = join(store, "draft.json");
    await writeDraft(draftPath);
    const root = await recordBranch({ branchId: "brn-root-001", parentBranchId: null, draftPath, store });
    expect(root.status).toBe("recorded");
    const child = await recordBranch({ branchId: "brn-child-01", parentBranchId: "brn-root-001", draftPath, store });
    expect(child.branch.parent_branch_id).toBe("brn-root-001");
    await expect(
      recordBranch({ branchId: "brn-orphan-01", parentBranchId: "brn-missing-01", draftPath, store }),
    ).rejects.toMatchObject({ code: "BRANCH_MISSING" });
  });

  it("evaluates a branch deterministically with the benchmark grader", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-branch-"));
    const draftPath = join(store, "draft.json");
    await writeDraft(draftPath);
    await recordBranch({ branchId: "brn-eval-001", parentBranchId: null, draftPath, store });

    const passing = await evaluateBranch({
      branchId: "brn-eval-001",
      taskPath: fixture("tasks", "task-001-refund.json"),
      candidateStatePath: fixture("dal", "fixtures", "result-pass.json"),
      store,
    });
    expect(passing.evaluation.passed).toBe(true);
    expect(passing.evaluation.score).toBe(1);

    const failing = await evaluateBranch({
      branchId: "brn-eval-001",
      taskPath: fixture("tasks", "task-001-refund.json"),
      candidateStatePath: fixture("dal", "fixtures", "result-fail.json"),
      store,
    });
    expect(failing.evaluation.passed).toBe(false);
    expect(failing.evaluation.score).toBe(0);
    expect(failing.evaluation.checks.find((check) => check.id === "policy:full-refund-requires-label")?.pass).toBe(false);

    const stats = await branchStats({ store });
    expect(stats).toHaveLength(1);
    expect(stats[0]?.visits).toBe(2);
    expect(stats[0]?.mean_score).toBe(0.5);
  });

  it("selects unexplored branches first, then higher UCB", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-branch-"));
    const draftPath = join(store, "draft.json");
    await writeDraft(draftPath);
    await recordBranch({ branchId: "brn-aaa-001", parentBranchId: null, draftPath, store });
    await recordBranch({ branchId: "brn-bbb-001", parentBranchId: null, draftPath, store });

    let selected = selectBranchUcb(await branchStats({ store }));
    expect(selected.selected).toBe("brn-aaa-001");
    expect(selected.reason).toContain("unexplored");

    await evaluateBranch({
      branchId: "brn-aaa-001",
      taskPath: fixture("tasks", "task-001-refund.json"),
      candidateStatePath: fixture("dal", "fixtures", "result-fail.json"),
      store,
    });
    await evaluateBranch({
      branchId: "brn-bbb-001",
      taskPath: fixture("tasks", "task-001-refund.json"),
      candidateStatePath: fixture("dal", "fixtures", "result-pass.json"),
      store,
    });
    selected = selectBranchUcb(await branchStats({ store }));
    expect(selected.selected).toBe("brn-bbb-001");
  });

  it("exposes the branch commands through the CLI", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-branch-"));
    const draftPath = join(store, "draft.json");
    await writeDraft(draftPath);
    const record = captureIo();
    expect(await runCli(["branch", "record", "--branch", "brn-cli-0001", "--draft", draftPath, "--store", store], record.io)).toBe(0);
    expect(JSON.parse(record.stdout.join(""))).toMatchObject({ status: "recorded" });

    const evaluate = captureIo();
    expect(
      await runCli(
        ["branch", "evaluate", "--branch", "brn-cli-0001", "--task", fixture("tasks", "task-001-refund.json"), "--state", fixture("dal", "fixtures", "result-pass.json"), "--store", store],
        evaluate.io,
      ),
    ).toBe(0);
    expect(JSON.parse(evaluate.stdout.join(""))).toMatchObject({ passed: true, score: 1 });

    const select = captureIo();
    expect(await runCli(["branch", "select", "--store", store], select.io)).toBe(0);
    expect(JSON.parse(select.stdout.join(""))).toMatchObject({ selected: "brn-cli-0001" });
  });
});
