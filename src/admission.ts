import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { DalError } from "./errors.js";
import { publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { Policy } from "./types.js";

export interface AdmissionChallenge {
  $schema: string;
  schema_version: "1.0.0";
  admission_id: string;
  candidate_ref: string;
  candidate_sha256: string;
  nonce: string;
  created_at: string;
}

export interface AdmissionProbeResult {
  $schema: string;
  schema_version: "1.0.0";
  admission_id: string;
  candidate_sha256: string;
  nonce: string;
  outcome: "passed" | "failed";
}

export interface AdmissionReceipt {
  $schema: string;
  schema_version: "1.0.0";
  admission_id: string;
  candidate_sha256: string;
  nonce: string;
  outcome: "passed" | "failed";
  result_ref: string;
  result_sha256: string;
  completed_at: string;
}

export interface AdmissionIssueResult {
  status: "issued";
  path: string;
  challenge: AdmissionChallenge;
}

export interface AdmissionCompleteResult {
  status: "admitted" | "rejected" | "idempotent";
  path: string;
  receipt: AdmissionReceipt;
}

export interface AdmissionStatusResult {
  challenge: AdmissionChallenge | null;
  receipt: AdmissionReceipt | null;
  state: "unknown" | "pending" | "passed" | "failed";
}

function admissionStore(policy: Policy, requested?: string): string {
  return resolve(
    process.cwd(),
    requested ?? (policy as Policy & { default_admission_store?: string }).default_admission_store ?? ".dal/admissions",
  );
}

export async function issueAdmission(options: {
  admissionId: string;
  candidateRef: string;
  candidateSha256: string;
  store?: string;
}): Promise<AdmissionIssueResult> {
  const policy = await loadPolicy();
  const store = admissionStore(policy, options.store);
  const challenge: AdmissionChallenge = {
    $schema: SCHEMA_IDS.admissionChallenge,
    schema_version: "1.0.0",
    admission_id: options.admissionId,
    candidate_ref: options.candidateRef,
    candidate_sha256: options.candidateSha256,
    nonce: randomBytes(32).toString("hex"),
    created_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.admissionChallenge, challenge, "Admission challenge");
  const destination = resolve(store, `${options.admissionId}.challenge.json`);
  const published = await publishJsonExclusive(destination, challenge);
  if (!published) {
    const existing = await readJsonFile<AdmissionChallenge>(destination);
    if (
      existing.value.candidate_ref === challenge.candidate_ref &&
      existing.value.candidate_sha256 === challenge.candidate_sha256
    ) {
      return { status: "issued", path: destination, challenge: existing.value };
    }
    throw new DalError("ADMIT_CHALLENGE_CONFLICT", `Admission ${options.admissionId} already exists for a different candidate`);
  }
  return { status: "issued", path: destination, challenge };
}

export async function completeAdmission(options: {
  admissionId: string;
  resultPath: string;
  store?: string;
}): Promise<AdmissionCompleteResult> {
  const policy = await loadPolicy();
  const store = admissionStore(policy, options.store);
  const challengePath = resolve(store, `${options.admissionId}.challenge.json`);
  let challenge: AdmissionChallenge;
  try {
    const document = await readJsonFile<unknown>(challengePath);
    await assertSchema(SCHEMA_IDS.admissionChallenge, document.value, "Admission challenge");
    challenge = document.value as AdmissionChallenge;
  } catch (error) {
    if (error instanceof DalError && error.code === "FILE_READ_FAILED") {
      throw new DalError("ADMIT_MISSING", `Admission ${options.admissionId} was never issued`);
    }
    throw error;
  }

  const resultDocument = await readJsonFile<unknown>(options.resultPath);
  await assertSchema(SCHEMA_IDS.admissionProbeResult, resultDocument.value, "Admission probe result");
  const result = resultDocument.value as AdmissionProbeResult;
  if (result.admission_id !== challenge.admission_id) {
    throw new DalError("ADMIT_NONCE_MISMATCH", "Probe result admission identity does not match the challenge");
  }
  if (result.nonce !== challenge.nonce) {
    throw new DalError("ADMIT_NONCE_MISMATCH", "Probe result nonce does not match the issued challenge; forged or stale control records fail closed");
  }
  if (result.candidate_sha256 !== challenge.candidate_sha256) {
    throw new DalError("ADMIT_CANDIDATE_MISMATCH", "Probe result candidate digest does not match the challenge");
  }

  const receipt: AdmissionReceipt = {
    $schema: SCHEMA_IDS.admissionReceipt,
    schema_version: "1.0.0",
    admission_id: challenge.admission_id,
    candidate_sha256: challenge.candidate_sha256,
    nonce: challenge.nonce,
    outcome: result.outcome,
    result_ref: "file://" + resolve(process.cwd(), options.resultPath),
    result_sha256: sha256(resultDocument.raw.toString("utf8")),
    completed_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.admissionReceipt, receipt, "Admission receipt");
  const destination = resolve(store, `${options.admissionId}.receipt.json`);
  const published = await publishJsonExclusive(destination, receipt);
  if (!published) {
    const existing = await readJsonFile<AdmissionReceipt>(destination);
    if (
      existing.value.outcome === receipt.outcome &&
      existing.value.nonce === receipt.nonce &&
      existing.value.candidate_sha256 === receipt.candidate_sha256 &&
      existing.value.result_sha256 === receipt.result_sha256
    ) {
      return { status: "idempotent", path: destination, receipt: existing.value };
    }
    throw new DalError("ADMIT_RECEIPT_CONFLICT", `Admission ${options.admissionId} already has a different receipt`);
  }
  return {
    status: receipt.outcome === "passed" ? "admitted" : "rejected",
    path: destination,
    receipt,
  };
}

export async function admissionStatus(options: { admissionId: string; store?: string }): Promise<AdmissionStatusResult> {
  const policy = await loadPolicy();
  const store = admissionStore(policy, options.store);
  let challenge: AdmissionChallenge | null = null;
  let receipt: AdmissionReceipt | null = null;
  try {
    const document = await readJsonFile<unknown>(resolve(store, `${options.admissionId}.challenge.json`));
    await assertSchema(SCHEMA_IDS.admissionChallenge, document.value, "Admission challenge");
    challenge = document.value as AdmissionChallenge;
  } catch (error) {
    if (!(error instanceof DalError && error.code === "FILE_READ_FAILED")) {
      throw error;
    }
  }
  try {
    const document = await readJsonFile<unknown>(resolve(store, `${options.admissionId}.receipt.json`));
    await assertSchema(SCHEMA_IDS.admissionReceipt, document.value, "Admission receipt");
    receipt = document.value as AdmissionReceipt;
  } catch (error) {
    if (!(error instanceof DalError && error.code === "FILE_READ_FAILED")) {
      throw error;
    }
  }
  return {
    challenge,
    receipt,
    state: challenge === null ? "unknown" : receipt === null ? "pending" : receipt.outcome,
  };
}
