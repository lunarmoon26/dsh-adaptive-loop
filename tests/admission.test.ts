import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { admissionStatus, completeAdmission, issueAdmission } from "../src/admission.js";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/json.js";

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

async function makeCandidate(content = '{"candidate":"bounded edit"}'): Promise<{ path: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dal-admit-candidate-"));
  const path = join(dir, "candidate.json");
  await writeFile(path, `${content}\n`, "utf8");
  return { path, digest: sha256(await readFile(path)) };
}

async function writeProbeResult(
  resultPath: string,
  options: { admissionId: string; candidateSha256: string; nonce: string; outcome?: string },
): Promise<void> {
  const result = {
    $schema: "https://recursive-dev-loop.dev/schemas/admission-probe-result.v1.schema.json",
    schema_version: "1.0.0",
    admission_id: options.admissionId,
    candidate_sha256: options.candidateSha256,
    nonce: options.nonce,
    outcome: options.outcome ?? "passed",
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

describe("nonce-bound admission receipts", () => {
  it("issues a challenge and admits a probe result that binds the nonce", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-admit-"));
    const candidate = await makeCandidate();
    const issued = await issueAdmission({
      admissionId: "adm-candidate-001",
      candidateRef: "file://" + candidate.path,
      candidateSha256: candidate.digest,
      store,
    });
    expect(issued.status).toBe("issued");
    expect(issued.challenge.nonce).toMatch(/^[a-f0-9]{64}$/);

    const resultPath = join(store, "probe-result.json");
    await writeProbeResult(resultPath, {
      admissionId: "adm-candidate-001",
      candidateSha256: candidate.digest,
      nonce: issued.challenge.nonce,
    });
    const completed = await completeAdmission({ admissionId: "adm-candidate-001", resultPath, store });
    expect(completed.status).toBe("admitted");
    expect(completed.receipt.nonce).toBe(issued.challenge.nonce);

    const status = await admissionStatus({ admissionId: "adm-candidate-001", store });
    expect(status.state).toBe("passed");
  });

  it("fails closed on a forged or stale nonce", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-admit-"));
    const candidate = await makeCandidate();
    const issued = await issueAdmission({
      admissionId: "adm-candidate-002",
      candidateRef: "file://" + candidate.path,
      candidateSha256: candidate.digest,
      store,
    });
    const resultPath = join(store, "forged.json");
    await writeProbeResult(resultPath, {
      admissionId: "adm-candidate-002",
      candidateSha256: candidate.digest,
      nonce: "f".repeat(64),
    });
    await expect(completeAdmission({ admissionId: "adm-candidate-002", resultPath, store })).rejects.toMatchObject({
      code: "ADMIT_NONCE_MISMATCH",
    });
  });

  it("fails closed when the result is for a different candidate or unissued admission", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-admit-"));
    const candidate = await makeCandidate();
    const other = await makeCandidate('{"candidate":"different content"}');
    const issued = await issueAdmission({
      admissionId: "adm-candidate-003",
      candidateRef: "file://" + candidate.path,
      candidateSha256: candidate.digest,
      store,
    });
    const resultPath = join(store, "wrong-candidate.json");
    await writeProbeResult(resultPath, {
      admissionId: "adm-candidate-003",
      candidateSha256: other.digest,
      nonce: issued.challenge.nonce,
    });
    await expect(completeAdmission({ admissionId: "adm-candidate-003", resultPath, store })).rejects.toMatchObject({
      code: "ADMIT_CANDIDATE_MISMATCH",
    });

    const unissuedPath = join(store, "unissued.json");
    await writeProbeResult(unissuedPath, {
      admissionId: "adm-never-issued",
      candidateSha256: candidate.digest,
      nonce: "0".repeat(64),
    });
    await expect(completeAdmission({ admissionId: "adm-never-issued", resultPath: unissuedPath, store })).rejects.toMatchObject({
      code: "ADMIT_MISSING",
    });
  });

  it("records a rejection for a failed probe and refuses conflicting double completion", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-admit-"));
    const candidate = await makeCandidate();
    const issued = await issueAdmission({
      admissionId: "adm-candidate-004",
      candidateRef: "file://" + candidate.path,
      candidateSha256: candidate.digest,
      store,
    });
    const failPath = join(store, "fail.json");
    await writeProbeResult(failPath, {
      admissionId: "adm-candidate-004",
      candidateSha256: candidate.digest,
      nonce: issued.challenge.nonce,
      outcome: "failed",
    });
    const rejected = await completeAdmission({ admissionId: "adm-candidate-004", resultPath: failPath, store });
    expect(rejected.status).toBe("rejected");

    const passPath = join(store, "pass.json");
    await writeProbeResult(passPath, {
      admissionId: "adm-candidate-004",
      candidateSha256: candidate.digest,
      nonce: issued.challenge.nonce,
    });
    await expect(completeAdmission({ admissionId: "adm-candidate-004", resultPath: passPath, store })).rejects.toMatchObject({
      code: "ADMIT_RECEIPT_CONFLICT",
    });
  });

  it("exposes the admission commands through the CLI", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-admit-"));
    const candidate = await makeCandidate();
    const issue = captureIo();
    expect(
      await runCli(["admit", "issue", "--admission", "adm-cli-0001", "--candidate", candidate.path, "--store", store], issue.io),
    ).toBe(0);
    const issued = JSON.parse(issue.stdout.join("")) as { nonce: string };
    const resultPath = join(store, "cli-result.json");
    await writeProbeResult(resultPath, {
      admissionId: "adm-cli-0001",
      candidateSha256: candidate.digest,
      nonce: issued.nonce,
    });
    const complete = captureIo();
    expect(await runCli(["admit", "complete", "--admission", "adm-cli-0001", "--result", resultPath, "--store", store], complete.io)).toBe(0);
    expect(JSON.parse(complete.stdout.join(""))).toMatchObject({ status: "admitted" });
    const status = captureIo();
    expect(await runCli(["admit", "status", "--admission", "adm-cli-0001", "--store", store], status.io)).toBe(0);
    expect(JSON.parse(status.stdout.join(""))).toMatchObject({ state: "passed" });
  });
});
