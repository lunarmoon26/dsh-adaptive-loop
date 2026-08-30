import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "./errors.js";
import { publishJsonExclusive, readJsonFile } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { Policy } from "./types.js";

export const SAGA_ACTIONS = [
  "ingest_feedback",
  "ingest_run",
  "publish_cluster",
  "publish_scorecard",
  "record_decision",
  "publish_proposal",
  "reveal_seal",
] as const;

export type SagaAction = (typeof SAGA_ACTIONS)[number];

export interface EffectIntent {
  $schema: string;
  schema_version: "1.0.0";
  intent_id: string;
  action: SagaAction;
  payload_ref: string;
  payload_sha256: string;
  created_at: string;
}

export interface EffectReceipt {
  $schema: string;
  schema_version: "1.0.0";
  intent_id: string;
  outcome: "completed" | "failed";
  receipt_ref: string;
  receipt_sha256: string;
  completed_at: string;
}

export interface SagaBeginResult {
  status: "recorded" | "idempotent";
  path: string;
  intent: EffectIntent;
}

export interface SagaCompleteResult {
  status: "completed" | "idempotent";
  path: string;
  receipt: EffectReceipt;
}

export interface SagaStatusResult {
  intent: EffectIntent | null;
  receipt: EffectReceipt | null;
  state: "unknown" | "pending" | "completed" | "failed";
}

function sagaStore(policy: Policy, requested?: string): string {
  return resolve(process.cwd(), requested ?? (policy as Policy & { default_saga_store?: string }).default_saga_store ?? ".dal/sagas");
}

export async function beginSaga(options: {
  intentId: string;
  action: SagaAction;
  payloadRef: string;
  payloadSha256: string;
  store?: string;
}): Promise<SagaBeginResult> {
  const policy = await loadPolicy();
  const store = sagaStore(policy, options.store);
  const intent: EffectIntent = {
    $schema: SCHEMA_IDS.effectIntent,
    schema_version: "1.0.0",
    intent_id: options.intentId,
    action: options.action,
    payload_ref: options.payloadRef,
    payload_sha256: options.payloadSha256,
    created_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.effectIntent, intent, "Effect intent");
  const destination = resolve(store, `${options.intentId}.intent.json`);
  const published = await publishJsonExclusive(destination, intent);
  if (!published) {
    const existing = await readJsonFile<EffectIntent>(destination);
    if (
      existing.value.intent_id === intent.intent_id &&
      existing.value.action === intent.action &&
      existing.value.payload_ref === intent.payload_ref &&
      existing.value.payload_sha256 === intent.payload_sha256
    ) {
      return { status: "idempotent", path: destination, intent: existing.value };
    }
    throw new DalError("SAGA_INTENT_CONFLICT", `Intent ${options.intentId} already exists with different content`);
  }
  return { status: "recorded", path: destination, intent };
}

export async function completeSaga(options: {
  intentId: string;
  outcome: "completed" | "failed";
  receiptRef: string;
  receiptSha256: string;
  store?: string;
}): Promise<SagaCompleteResult> {
  const policy = await loadPolicy();
  const store = sagaStore(policy, options.store);
  const intentPath = resolve(store, `${options.intentId}.intent.json`);
  let intent: EffectIntent;
  try {
    const document = await readJsonFile<unknown>(intentPath);
    await assertSchema(SCHEMA_IDS.effectIntent, document.value, "Effect intent");
    intent = document.value as EffectIntent;
  } catch (error) {
    if (error instanceof DalError && error.code === "FILE_READ_FAILED") {
      throw new DalError("SAGA_INTENT_MISSING", `Intent ${options.intentId} has no recorded intent`);
    }
    throw error;
  }

  const receipt: EffectReceipt = {
    $schema: SCHEMA_IDS.effectReceipt,
    schema_version: "1.0.0",
    intent_id: intent.intent_id,
    outcome: options.outcome,
    receipt_ref: options.receiptRef,
    receipt_sha256: options.receiptSha256,
    completed_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.effectReceipt, receipt, "Effect receipt");
  const destination = resolve(store, `${options.intentId}.receipt.json`);
  const published = await publishJsonExclusive(destination, receipt);
  if (!published) {
    const existing = await readJsonFile<EffectReceipt>(destination);
    if (
      existing.value.intent_id === receipt.intent_id &&
      existing.value.outcome === receipt.outcome &&
      existing.value.receipt_ref === receipt.receipt_ref &&
      existing.value.receipt_sha256 === receipt.receipt_sha256
    ) {
      return { status: "idempotent", path: destination, receipt: existing.value };
    }
    throw new DalError("SAGA_RECEIPT_CONFLICT", `Intent ${options.intentId} already has a different completion receipt`);
  }
  return { status: "completed", path: destination, receipt };
}

export async function sagaStatus(options: { intentId: string; store?: string }): Promise<SagaStatusResult> {
  const policy = await loadPolicy();
  const store = sagaStore(policy, options.store);
  const intentPath = resolve(store, `${options.intentId}.intent.json`);
  const receiptPath = resolve(store, `${options.intentId}.receipt.json`);
  let intent: EffectIntent | null = null;
  let receipt: EffectReceipt | null = null;
  try {
    const document = await readJsonFile<unknown>(intentPath);
    await assertSchema(SCHEMA_IDS.effectIntent, document.value, "Effect intent");
    intent = document.value as EffectIntent;
  } catch (error) {
    if (!(error instanceof DalError && error.code === "FILE_READ_FAILED")) {
      throw error;
    }
  }
  try {
    const document = await readJsonFile<unknown>(receiptPath);
    await assertSchema(SCHEMA_IDS.effectReceipt, document.value, "Effect receipt");
    receipt = document.value as EffectReceipt;
  } catch (error) {
    if (!(error instanceof DalError && error.code === "FILE_READ_FAILED")) {
      throw error;
    }
  }
  return {
    intent,
    receipt,
    state: intent === null ? "unknown" : receipt === null ? "pending" : receipt.outcome,
  };
}

export async function listSagas(options: { store?: string } = {}): Promise<SagaStatusResult[]> {
  const policy = await loadPolicy();
  const store = sagaStore(policy, options.store);
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".intent.json")).sort();
  } catch {
    return [];
  }
  const results: SagaStatusResult[] = [];
  for (const name of names) {
    const statusOptions: { intentId: string; store?: string } = { intentId: name.slice(0, -".intent.json".length) };
    if (options.store !== undefined) {
      statusOptions.store = options.store;
    }
    results.push(await sagaStatus(statusOptions));
  }
  return results;
}
