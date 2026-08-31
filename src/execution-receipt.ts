import { DalError } from "./errors.js";
import { readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { ExecutionReceipt } from "./types.js";

/**
 * Execution-receipt chain (audit P0-2): a branch evaluation may only count
 * as provenance-valid when a receipt binds the graded state to an actual
 * candidate run — candidate digest, generation ids, effective composition,
 * session identity, external state digests, and the grader receipt.
 */

export async function validateExecutionReceipt(value: unknown): Promise<ExecutionReceipt> {
  await assertSchema(SCHEMA_IDS.executionReceipt, value, "Execution receipt");
  const receipt = value as ExecutionReceipt;
  assertNoSecrets(scanSecrets(receipt));
  assertNoPii(scanPii(receipt));
  return receipt;
}

export async function readExecutionReceipt(path: string): Promise<ExecutionReceipt> {
  const document = await readJsonFile<unknown>(path);
  return validateExecutionReceipt(document.value);
}

/**
 * The binding rule: the receipt must name the exact graded external state.
 * A receipt pointing at any other state fails closed with
 * BRANCH_RECEIPT_MISMATCH, so a hand-written state file cannot earn a
 * provenance-valid evaluation.
 */
export function bindReceiptToState(receipt: ExecutionReceipt, stateDigest: string): void {
  if (receipt.external_state_after_sha256 !== stateDigest) {
    throw new DalError(
      "BRANCH_RECEIPT_MISMATCH",
      "The execution receipt does not bind this candidate state: its external_state_after_sha256 must equal the graded state digest",
      [`receipt: ${receipt.external_state_after_sha256}`, `state: ${stateDigest}`],
    );
  }
}

export function receiptDigest(receipt: ExecutionReceipt): string {
  return sha256(JSON.stringify(receipt));
}
