import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "./errors.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { Policy, RunRecord } from "./types.js";

export interface RunRecordIngestResult {
  status: "stored" | "idempotent";
  path: string;
  record: RunRecord;
  run_sha256: string;
}

export async function validateRunRecord(value: unknown, rawText?: string): Promise<RunRecord> {
  await assertSchema(SCHEMA_IDS.runRecord, value, "Run record");
  const run = value as RunRecord;
  const issues: string[] = [];
  if (Date.parse(run.finished_at) < Date.parse(run.started_at)) {
    issues.push("/finished_at must not precede /started_at");
  }
  if (run.outcome === "failed" && run.failure === null) {
    issues.push("/failure is required when the harness outcome is failed");
  }
  if (run.outcome !== "failed" && run.failure !== null) {
    issues.push("/failure must be null unless the harness outcome is failed");
  }
  if (
    run.outcome !== "succeeded" &&
    run.business_outcome !== undefined &&
    run.business_outcome !== null &&
    run.business_outcome.status !== "unknown"
  ) {
    issues.push("/business_outcome.status may be passed or failed only when the harness outcome is succeeded");
  }
  if (
    run.business_outcome?.status === "failed" &&
    !(run.checks ?? []).some((check) => !check.pass)
  ) {
    issues.push("/checks must contain at least one failed deterministic check when /business_outcome.status is failed");
  }
  if (issues.length > 0) {
    throw new DalError("RUN_RECORD_INVALID", "Run record violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(run, rawText));
  assertNoPii(scanPii(run, rawText));
  return run;
}

export async function ingestRunRecord(
  filePath: string,
  requestedStore?: string,
  suppliedPolicy?: Policy,
): Promise<RunRecordIngestResult> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  const document = await readJsonFile<unknown>(filePath);
  const run = await validateRunRecord(document.value, document.raw.toString("utf8"));

  const store = resolve(process.cwd(), requestedStore ?? policy.default_run_store);
  const destination = resolve(store, `${run.run_id}.json`);
  const runDigest = sha256(canonicalJson(run));

  const existing = await readExistingRun(destination);
  if (existing !== undefined) {
    if (sha256(canonicalJson(existing)) === runDigest) {
      return { status: "idempotent", path: destination, record: existing, run_sha256: runDigest };
    }
    throw new DalError("RUN_ID_CONFLICT", `Run ID ${run.run_id} already has a different record`);
  }

  const published = await publishJsonExclusive(destination, run);
  if (!published) {
    const raced = await readExistingRun(destination);
    if (raced !== undefined && sha256(canonicalJson(raced)) === runDigest) {
      return { status: "idempotent", path: destination, record: raced, run_sha256: runDigest };
    }
    throw new DalError("RUN_ID_CONFLICT", `Run ID ${run.run_id} raced with different content`);
  }
  return { status: "stored", path: destination, record: run, run_sha256: runDigest };
}

async function readExistingRun(destination: string): Promise<RunRecord | undefined> {
  try {
    await access(destination);
  } catch {
    return undefined;
  }
  const document = await readJsonFile<unknown>(destination);
  try {
    return await validateRunRecord(document.value);
  } catch {
    throw new DalError("RUN_STORE_INVALID", `Existing run record is invalid: ${destination}`);
  }
}
