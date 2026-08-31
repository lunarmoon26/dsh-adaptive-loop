import { access, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { DalError, isNodeError } from "./errors.js";
import { validateFeedback, validateFeedbackDocument } from "./feedback.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { FeedbackOutcome, Policy, StoredFeedbackRecord } from "./types.js";

export interface IngestResult {
  status: "stored" | "idempotent";
  path: string;
  record: StoredFeedbackRecord;
}

export interface FeedbackQuery {
  feedbackId?: string;
  changeId?: string;
  outcome?: FeedbackOutcome;
  privacyTag?: string;
  from?: string;
  to?: string;
}

export interface FeedbackSummary {
  total_records: number;
  outcomes: Record<FeedbackOutcome, number>;
  inefficiencies: {
    total: number;
    by_category: Record<string, number>;
  };
}

export async function ingestFeedback(sourcePath: string, requestedStore?: string): Promise<IngestResult> {
  const { feedback, raw, policy } = await validateFeedbackDocument(sourcePath);
  if (feedback.privacy.retention === "ephemeral") {
    throw new DalError("EPHEMERAL_INGEST_DENIED", "Ephemeral feedback cannot be ingested into the durable store");
  }

  const storePath = resolveStorePath(requestedStore, policy);
  const destination = resolve(storePath, `${feedback.feedback_id}.json`);
  const feedbackDigest = sha256(canonicalJson(feedback));
  const timestamp = new Date().toISOString();
  const record: StoredFeedbackRecord = {
    $schema: SCHEMA_IDS.storedFeedback,
    storage_version: "1.0.0",
    record_id: feedback.feedback_id,
    ingested_at: timestamp,
    source: {
      display_path: displayPath(sourcePath),
      sha256: sha256(raw),
    },
    feedback_sha256: feedbackDigest,
    privacy_scan: {
      ruleset_version: policy.secret_ruleset_version,
      pii_ruleset_version: policy.pii_ruleset_version,
      status: "passed",
      scanned_at: timestamp,
      matched_rules: [],
    },
    feedback,
  };
  assertNoSecrets(scanSecrets(record));
  assertNoPii(scanPii(record));

  const existing = await readExisting(destination, policy);
  if (existing !== undefined) {
    return identicalOrConflict(destination, existing, feedbackDigest, feedback);
  }

  const names = await storeJsonNames(storePath);
  if (names.length >= policy.max_store_records) {
    throw new DalError("STORE_LIMIT_REACHED", `Store already contains ${names.length} records`);
  }

  await assertSchema(SCHEMA_IDS.storedFeedback, record, "Stored feedback record");
  const published = await publishJsonExclusive(destination, record);
  if (!published) {
    const raced = await readExisting(destination, policy);
    if (raced === undefined) {
      throw new DalError("STORE_PUBLISH_FAILED", `Record appeared during ingestion but cannot be read: ${destination}`);
    }
    return identicalOrConflict(destination, raced, feedbackDigest, feedback);
  }

  return { status: "stored", path: destination, record };
}

export async function queryFeedback(
  query: FeedbackQuery = {},
  requestedStore?: string,
): Promise<StoredFeedbackRecord[]> {
  const policy = await loadPolicy();
  const storePath = resolveStorePath(requestedStore, policy);
  const from = query.from === undefined ? undefined : parseDate(query.from, "from");
  const to = query.to === undefined ? undefined : parseDate(query.to, "to");
  if (from !== undefined && to !== undefined && from > to) {
    throw new DalError("INVALID_DATE_RANGE", "Query --from must not be later than --to");
  }

  const records = await readStore(storePath, policy);
  return records.filter((record) => {
    const feedback = record.feedback;
    const created = Date.parse(feedback.created_at);
    return (
      (query.feedbackId === undefined || feedback.feedback_id === query.feedbackId) &&
      (query.changeId === undefined || feedback.change_id === query.changeId) &&
      (query.outcome === undefined || feedback.outcome.status === query.outcome) &&
      (query.privacyTag === undefined || feedback.privacy.tags.includes(query.privacyTag)) &&
      (from === undefined || created >= from) &&
      (to === undefined || created <= to)
    );
  });
}

export function summarizeFeedback(records: readonly StoredFeedbackRecord[]): FeedbackSummary {
  const outcomes: Record<FeedbackOutcome, number> = { completed: 0, blocked: 0, aborted: 0 };
  const categories = new Map<string, number>();
  let inefficiencyTotal = 0;

  for (const record of records) {
    outcomes[record.feedback.outcome.status] += 1;
    for (const inefficiency of record.feedback.failures_and_inefficiencies) {
      inefficiencyTotal += 1;
      categories.set(inefficiency.category, (categories.get(inefficiency.category) ?? 0) + 1);
    }
  }

  return {
    total_records: records.length,
    outcomes,
    inefficiencies: {
      total: inefficiencyTotal,
      by_category: Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

export async function validateStoredFeedback(
  value: unknown,
  suppliedPolicy?: Policy,
): Promise<StoredFeedbackRecord> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  await assertSchema(SCHEMA_IDS.storedFeedback, value, "Stored feedback record");
  const record = value as StoredFeedbackRecord;
  await validateFeedback(record.feedback, policy);

  const issues: string[] = [];
  if (record.record_id !== record.feedback.feedback_id) {
    issues.push("/record_id must equal /feedback/feedback_id");
  }
  const digest = sha256(canonicalJson(record.feedback));
  if (record.feedback_sha256 !== digest) {
    issues.push("/feedback_sha256 does not match the canonical feedback content");
  }
  assertNoSecrets(scanSecrets(record));
  assertNoPii(scanPii(record));
  if (issues.length > 0) {
    throw new DalError("STORED_RECORD_INVALID", "Stored feedback integrity check failed", issues);
  }
  return record;
}

function resolveStorePath(requestedStore: string | undefined, policy: Policy): string {
  return resolve(process.cwd(), requestedStore ?? policy.default_store);
}

async function readStore(storePath: string, policy: Policy): Promise<StoredFeedbackRecord[]> {
  const names = await storeJsonNames(storePath);
  if (names.length > policy.max_store_records) {
    throw new DalError("STORE_LIMIT_EXCEEDED", `Store contains ${names.length} records, above the policy limit`);
  }
  const records: StoredFeedbackRecord[] = [];
  for (const name of names) {
    const filePath = resolve(storePath, name);
    const { value } = await readJsonFile<unknown>(filePath);
    const record = await validateStoredFeedback(value, policy);
    if (name !== `${record.record_id}.json`) {
      throw new DalError("STORED_RECORD_INVALID", `Stored record filename does not match record_id: ${name}`);
    }
    records.push(record);
  }
  return records.sort(
    (left, right) =>
      left.feedback.created_at.localeCompare(right.feedback.created_at) || left.record_id.localeCompare(right.record_id),
  );
}

async function storeJsonNames(storePath: string): Promise<string[]> {
  try {
    return (await readdir(storePath)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw new DalError("STORE_READ_FAILED", `Could not read feedback store: ${storePath}`);
  }
}

async function readExisting(filePath: string, policy: Policy): Promise<StoredFeedbackRecord | undefined> {
  try {
    await access(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new DalError("STORE_READ_FAILED", `Could not inspect stored record: ${filePath}`);
  }
  const { value } = await readJsonFile<unknown>(filePath);
  return validateStoredFeedback(value, policy);
}

function identicalOrConflict(
  destination: string,
  existing: StoredFeedbackRecord,
  feedbackDigest: string,
  feedback: unknown,
): IngestResult {
  if (existing.feedback_sha256 === feedbackDigest && canonicalJson(existing.feedback) === canonicalJson(feedback)) {
    return { status: "idempotent", path: destination, record: existing };
  }
  throw new DalError(
    "FEEDBACK_ID_CONFLICT",
    `Feedback ID ${existing.record_id} already exists with different content`,
  );
}

function displayPath(sourcePath: string): string {
  const absolute = resolve(process.cwd(), sourcePath);
  const local = relative(process.cwd(), absolute);
  if (local !== "" && !local.startsWith("..") && !isAbsolute(local)) {
    return local;
  }
  return sourcePath;
}

function parseDate(value: string, option: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new DalError("INVALID_DATE", `Invalid --${option} date: ${value}`);
  }
  return parsed;
}
