import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { sealInit, sealReveal, sealVerify } from "../src/seal.js";

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

async function makeCases(): Promise<string> {
  const casesDir = await mkdtemp(join(tmpdir(), "dal-seal-cases-"));
  for (const [taskId, extra] of [
    ["task-001-refund", '"refunds": []'],
    ["task-002-booking", '"bookings": {}'],
    ["task-003-refusal", '"labels": []'],
    ["task-004-partial", '"orders": {}'],
    ["task-005-expired", '"bookings": {}'],
  ] as const) {
    const task = {
      task_id: taskId,
      domain: "retail",
      instruction: `Synthetic case ${taskId}.`,
      initial_state: { extra },
      goal_state: {},
      policy_ref: "policy.md",
    };
    await writeFile(join(casesDir, `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }
  return casesDir;
}

describe("sealed holdout", () => {
  it("commits a split with a Merkle root, lock, and one-shot semantics", async () => {
    const casesDir = await makeCases();
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    const result = await sealInit({ casesDir, outputDir, holdoutCount: 2 });
    expect(result.status).toBe("sealed");
    expect(result.observed_cases).toHaveLength(3);
    expect(result.holdout_handles).toHaveLength(2);
    expect(result.holdout_handles.every((handle) => handle.startsWith("seal-handle-"))).toBe(true);
    await access(join(outputDir, "lock"));
    await access(join(outputDir, "commitment.json"));

    const verify = await sealVerify({ sealedDir: outputDir, casesDir });
    expect(verify.status).toBe("valid");
    expect(verify.locked).toBe(true);
    expect(verify.revealed).toBe(false);
    expect(verify.case_count).toBe(5);

    await expect(sealInit({ casesDir, outputDir, holdoutCount: 2 })).rejects.toMatchObject({ code: "SEAL_LOCKED" });
  });

  it("detects any case drift after sealing", async () => {
    const casesDir = await makeCases();
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    await sealInit({ casesDir, outputDir, holdoutCount: 2 });
    await writeFile(join(casesDir, "task-001-refund.json"), '{"task_id":"task-001-refund","tampered":true}\n', "utf8");
    await expect(sealVerify({ sealedDir: outputDir, casesDir })).rejects.toMatchObject({ code: "SEAL_DRIFT" });
  });

  it("reveals the holdout exactly once for one candidate", async () => {
    const casesDir = await makeCases();
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    const init = await sealInit({ casesDir, outputDir, holdoutCount: 2 });
    const reveal = await sealReveal({ sealedDir: outputDir, candidateId: "candidate-v1" });
    expect(reveal.status).toBe("revealed");
    expect(reveal.holdout_cases).toHaveLength(2);
    expect(reveal.holdout_cases.every((entry) => entry.sha256.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(reveal.holdout_cases.map((entry) => entry.case_id)).not.toEqual(
      expect.arrayContaining(init.observed_cases),
    );

    await expect(sealReveal({ sealedDir: outputDir, candidateId: "candidate-v2" })).rejects.toMatchObject({
      code: "SEAL_REVEALED",
    });
    const verify = await sealVerify({ sealedDir: outputDir, casesDir });
    expect(verify.revealed).toBe(true);

    const persisted = JSON.parse(await readFile(join(outputDir, "reveal.json"), "utf8")) as { holdout_cases: unknown[] };
    expect(persisted.holdout_cases).toEqual(reveal.holdout_cases);
  });

  it("exposes the seal commands through the CLI", async () => {
    const casesDir = await makeCases();
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    const captured = captureIo();
    expect(
      await runCli(["seal", "init", "--cases", casesDir, "--output", outputDir, "--holdout", "2"], captured.io),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "sealed" });

    const verify = captureIo();
    expect(await runCli(["seal", "verify", "--sealed", outputDir, "--cases", casesDir], verify.io)).toBe(0);
    expect(JSON.parse(verify.stdout.join(""))).toMatchObject({ status: "valid", revealed: false });

    const reveal = captureIo();
    expect(await runCli(["seal", "reveal", "--sealed", outputDir, "--candidate", "candidate-v1"], reveal.io)).toBe(0);
    expect(JSON.parse(reveal.stdout.join(""))).toMatchObject({ status: "revealed" });
  });

  it("sources holdout cases from a private directory that never enters the seal records as content", async () => {
    const casesDir = await makeCases();
    const holdoutDir = await mkdtemp(join(tmpdir(), "dal-seal-holdout-"));
    await writeFile(
      join(holdoutDir, "holdout-h1.json"),
      `${JSON.stringify({
        task_id: "holdout-h1",
        domain: "retail",
        instruction: "Private holdout case one.",
        initial_state: {},
        goal_state: {},
        policy_ref: "policy.md",
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(holdoutDir, "holdout-h2.json"),
      `${JSON.stringify({
        task_id: "holdout-h2",
        domain: "retail",
        instruction: "Private holdout case two.",
        initial_state: {},
        goal_state: {},
        policy_ref: "policy.md",
      }, null, 2)}\n`,
      "utf8",
    );
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    const result = await sealInit({ casesDir, outputDir, holdoutCasesDir: holdoutDir });
    expect(result.commitment.observed_count).toBe(5);
    expect(result.commitment.holdout_count).toBe(2);
    expect(result.commitment.case_count).toBe(7);

    const sealedRecords = await readFile(join(outputDir, "sealed-manifest.json"), "utf8");
    expect(sealedRecords).toContain("holdout-h1");
    expect(sealedRecords).not.toContain("Private holdout case");

    const verify = await sealVerify({ sealedDir: outputDir, casesDir, holdoutCasesDir: holdoutDir });
    expect(verify.status).toBe("valid");

    await writeFile(
      join(holdoutDir, "holdout-h1.json"),
      `${JSON.stringify({ task_id: "holdout-h1", tampered: true }, null, 2)}\n`,
      "utf8",
    );
    await expect(sealVerify({ sealedDir: outputDir, casesDir, holdoutCasesDir: holdoutDir })).rejects.toMatchObject({
      code: "SEAL_DRIFT",
    });
  });

  it("fails closed when a holdout or seal directory is group/world-accessible", async () => {
    const casesDir = await makeCases();
    const holdoutDir = await mkdtemp(join(tmpdir(), "dal-seal-holdout-"));
    await writeFile(
      join(holdoutDir, "holdout-h1.json"),
      `${JSON.stringify({ task_id: "holdout-h1", domain: "retail", instruction: "Private case.", initial_state: {}, goal_state: {}, policy_ref: "policy.md" }, null, 2)}\n`,
      "utf8",
    );
    await chmod(holdoutDir, 0o755);
    const outputDir = await mkdtemp(join(tmpdir(), "dal-seal-out-"));
    await expect(sealInit({ casesDir, outputDir, holdoutCasesDir: holdoutDir })).rejects.toMatchObject({
      code: "SEAL_INSECURE",
    });
    await chmod(holdoutDir, 0o700);
  });
});
