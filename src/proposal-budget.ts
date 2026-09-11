import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { DalError, isNodeError } from "./errors.js";
import { canonicalJson, sha256 } from "./json.js";
import { verifyApprovalFile } from "./approval.js";

export const PROPOSAL_BUDGET_SCHEMA = "https://recursive-dev-loop.dev/schemas/proposal-budget.v1.schema.json";

export interface ProposalBudgetReservation {
  $schema: typeof PROPOSAL_BUDGET_SCHEMA;
  schema_version: "1.0.0";
  kind: "reservation";
  budget_id: string;
  provider: string;
  provider_limit_microusd: number;
  reservation_microusd: number;
  request_digest: string;
  approval_id: string;
  sequence: number;
  previous_sha256: string;
}

let validator: Promise<ValidateFunction> | undefined;

interface BudgetIdentity { store: string; budgetId: string; provider: string }
interface ExtensionInput extends BudgetIdentity { newLimit: number }

function validateIdentity({ store, budgetId, provider }: BudgetIdentity): void {
  if (typeof store !== "string" || !isAbsolute(store) || store.includes("\0") ||
      store.slice(parse(store).root.length).split("/").some(part => part === "." || part === "..") ||
      typeof budgetId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}(?![\s\S])/.test(budgetId) ||
      !["openai", "anthropic", "deepseek-official"].includes(provider)) {
    throw new DalError("PROPOSE_BUDGET_INVALID", "Invalid budget identity");
  }
}

function extensionRequest(budgetId: string, provider: string, oldLimit: number, newLimit: number,
  head: string, sequence: number, total: number) {
  return Object.freeze({ kind: "budget_cap_extension_request", schema_version: "1.0.0", budget_id: budgetId,
    provider, old_limit_microusd: oldLimit, new_limit_microusd: newLimit,
    head_sha256: head, sequence, reserved_microusd: total });
}

async function readChain(input: BudgetIdentity) {
  validateIdentity(input);
  validator ??= readFile(new URL("../schemas/proposal-budget.v1.schema.json", import.meta.url), "utf8")
    .then(raw => new Ajv2020({ strict: true }).compile(JSON.parse(raw)));
  const validate = await validator;
  const directory = join(input.store, input.budgetId, input.provider);
  try {
    await realDirectory(directory, false);
    if ((await readdir(directory)).sort().join(",") !== "cap.json,reservations") throw new Error("Unknown ledger entries");
    const records = join(directory, "reservations");
    await realDirectory(records, false);
    const cap = await readRecord(join(directory, "cap.json"), validate);
    if (cap.kind !== "cap" || cap.budget_id !== input.budgetId || cap.provider !== input.provider) throw new Error("Cap identity mismatch");
    let limit = cap.provider_limit_microusd as number;
    let total = 0;
    let previous = sha256(canonicalJson(cap));
    let reservations = 0;
    const seen = new Set<string>();
    const names = (await readdir(records)).sort();
    for (const [index, name] of names.entries()) {
      if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unknown chain entry");
      const record = await readRecord(join(records, name), validate);
      const digest = sha256(canonicalJson(record));
      if (record.budget_id !== input.budgetId || record.provider !== input.provider || record.sequence !== index + 1 ||
          record.previous_sha256 !== previous || name !== `${String(index + 1).padStart(16, "0")}-${digest}.json` ||
          seen.has(record.request_digest as string)) throw new Error("Chain mismatch");
      if (record.kind === "cap_extension") {
        const next = record.provider_limit_microusd as number;
        const request = extensionRequest(input.budgetId, input.provider, limit, next, previous, index, total);
        if (record.old_limit_microusd !== limit || next <= limit || record.reserved_microusd !== total ||
            record.reservation_microusd !== 0 || record.request_digest !== sha256(canonicalJson(request))) throw new Error("Invalid extension");
        limit = next;
      } else {
        const amount = record.reservation_microusd as number;
        if (record.kind !== "reservation" || record.provider_limit_microusd !== limit || amount > limit - total) throw new Error("Invalid reservation");
        total += amount;
        reservations++;
      }
      seen.add(record.request_digest as string);
      previous = digest;
    }
    return { provider_limit_microusd: limit, reserved_microusd: total, remaining_microusd: limit - total,
      head_sha256: previous, sequence: names.length, reservations, seen };
  } catch (error) {
    if (error instanceof DalError) throw error;
    throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget ledger is incomplete, corrupt, or inaccessible; investigate before retrying");
  }
}

/** Read-only, validated chain totals. Extensions are neither spend nor provider requests. */
export async function readProposalBudgetSnapshot(input: BudgetIdentity) {
  input = { ...input };
  validateIdentity(input);
  const lock = join(input.store, input.budgetId, `${input.provider}.lock`);
  const unlocked = async () => {
    try { await lstat(lock); }
    catch (error) { if (isNodeError(error) && error.code === "ENOENT") return; throw error; }
    throw new DalError("PROPOSE_BUDGET_BUSY", "Budget is locked; investigate before retrying");
  };
  await unlocked();
  const { seen: _seen, ...snapshot } = await readChain(input);
  await unlocked();
  return Object.freeze(snapshot);
}

/** Preparation writes nothing and authorizes nothing. newLimit is an absolute cumulative cap. */
export async function prepareBudgetExtension(input: ExtensionInput) {
  input = { ...input };
  if (!Number.isSafeInteger(input.newLimit) || input.newLimit <= 0) throw new DalError("PROPOSE_BUDGET_INVALID", "Extension limit must be a positive safe integer");
  const snapshot = await readProposalBudgetSnapshot(input);
  if (input.newLimit <= snapshot.provider_limit_microusd) throw new DalError("PROPOSE_BUDGET_INVALID", "Extension must increase the current cap");
  const request = extensionRequest(input.budgetId, input.provider, snapshot.provider_limit_microusd,
    input.newLimit, snapshot.head_sha256, snapshot.sequence, snapshot.reserved_microusd);
  const requestDigest = sha256(canonicalJson(request));
  return Object.freeze({ request, requestDigest, scope: `proposal-budget-extension:v1:${requestDigest}`, ...snapshot });
}

/** Append only after exact approval; never rewrite cap.json or historical reservations.
 * Rollback must retain extension files and use a reader that understands this kind.
 */
export async function extendProposalBudget(input: ExtensionInput & { approvalPath: string }) {
  input = { ...input };
  const prepared = await prepareBudgetExtension(input);
  const expectation = { action: "send_data_externally" as const, scope: prepared.scope };
  await verifyApprovalFile(input.approvalPath, expectation);
  const parent = join(input.store, input.budgetId);
  const directory = join(parent, input.provider);
  const lock = `${directory}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") throw new DalError("PROPOSE_BUDGET_BUSY", "Budget is locked; abandoned locks require manual investigation");
    throw error;
  }
  const ownedLock = await lstat(lock);
  try {
    await syncDirectory(parent);
    const current = await readChain(input);
    if (current.head_sha256 !== prepared.head_sha256 || current.sequence !== prepared.sequence ||
        current.reserved_microusd !== prepared.reserved_microusd || current.provider_limit_microusd !== prepared.request.old_limit_microusd) {
      throw new DalError("PROPOSE_BUDGET_STALE_HEAD", "Extension approval binds an earlier ledger head");
    }
    const decision = await verifyApprovalFile(input.approvalPath, expectation);
    if (current.seen.has(prepared.requestDigest)) throw new DalError("PROPOSE_REQUEST_ALREADY_RESERVED", "Extension request already exists");
    const extension = Object.freeze({ $schema: PROPOSAL_BUDGET_SCHEMA, schema_version: "1.0.0", kind: "cap_extension",
      budget_id: input.budgetId, provider: input.provider, provider_limit_microusd: input.newLimit,
      old_limit_microusd: current.provider_limit_microusd, reserved_microusd: current.reserved_microusd,
      reservation_microusd: 0, request_digest: prepared.requestDigest, approval_id: decision.decision_id,
      sequence: current.sequence + 1, previous_sha256: current.head_sha256 });
    if (!(await validator!)(extension)) throw new DalError("PROPOSE_BUDGET_INVALID", "Invalid extension record");
    const head = sha256(canonicalJson(extension));
    const path = join(directory, "reservations", `${String(extension.sequence).padStart(16, "0")}-${head}.json`);
    await writeExclusive(path, extension);
    return Object.freeze({ extension, path, scope: prepared.scope, requestDigest: prepared.requestDigest,
      head_sha256: head, sequence: extension.sequence, reserved_microusd: current.reserved_microusd,
      remaining_microusd: input.newLimit - current.reserved_microusd, provider_limit_microusd: input.newLimit });
  } finally {
    const current = await lstat(lock);
    if (!current.isDirectory() || current.dev !== ownedLock.dev || current.ino !== ownedLock.ino) throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget lock ownership changed");
    await rmdir(lock);
    await syncDirectory(parent);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function realDirectory(path: string, create: boolean): Promise<void> {
  // Walk from the filesystem root: recursive mkdir alone would follow symlink ancestors.
  const parent = dirname(path);
  if (parent !== path) await realDirectory(parent, create);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(parent);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
  if (!(await lstat(path)).isDirectory()) {
    throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget paths must be real directories without symlink ancestors");
  }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

async function readRecord(path: string, validate: ValidateFunction): Promise<Record<string, unknown>> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("Unsafe ledger file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Ledger file changed");
    const raw = await handle.readFile("utf8");
    const value: unknown = JSON.parse(raw);
    if (!validate(value) || raw !== `${canonicalJson(value)}\n`) throw new Error("Invalid ledger record");
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}

/** Call once after exact approval, before credentials or sending. Reservations are never refunded.
 * This caps approved reservation units, not provider bills. The store must be locally trusted;
 * like any local ledger, it cannot detect wholesale rollback or resist a concurrent filesystem owner.
 */
export async function reserveProposalBudget(input: {
  store: string;
  budget: { budget_id: string; provider_limit_microusd: number; reservation_microusd: number };
  provider: string;
  requestDigest: string;
  approvalId: string;
}): Promise<{ reservation: ProposalBudgetReservation; path: string; reserved_microusd: number; remaining_microusd: number }> {
  const { store, budget, provider, requestDigest, approvalId } = input;
  if (typeof store !== "string" || !isAbsolute(store) || store.includes("\0") ||
      store.slice(parse(store).root.length).split("/").some(part => part === "." || part === "..") ||
      !budget || typeof budget.budget_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}(?![\s\S])/.test(budget.budget_id) ||
      !["openai", "anthropic", "deepseek-official"].includes(provider) ||
      typeof requestDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(requestDigest) ||
      typeof approvalId !== "string" || !/^dec-[a-z0-9][a-z0-9._-]{2,95}(?![\s\S])/.test(approvalId) ||
      !Number.isSafeInteger(budget.provider_limit_microusd) || budget.provider_limit_microusd <= 0 ||
      !Number.isSafeInteger(budget.reservation_microusd) || budget.reservation_microusd <= 0 ||
      budget.reservation_microusd > budget.provider_limit_microusd) {
    throw new DalError("PROPOSE_BUDGET_INVALID", "Invalid proposal budget reservation inputs");
  }
  validator ??= readFile(new URL("../schemas/proposal-budget.v1.schema.json", import.meta.url), "utf8")
    .then(raw => new Ajv2020({ strict: true }).compile(JSON.parse(raw)));
  const validate = await validator;
  const parent = join(store, budget.budget_id);
  const directory = join(parent, provider);
  const lock = `${directory}.lock`;
  try {
    await realDirectory(parent, true);
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new DalError("PROPOSE_BUDGET_BUSY", "Budget is locked; abandoned locks require manual investigation");
    }
    throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget root is inaccessible or unsafe");
  }
  const ownedLock = await lstat(lock);
  try {
    await syncDirectory(parent);
    const cap = { $schema: PROPOSAL_BUDGET_SCHEMA, schema_version: "1.0.0", kind: "cap",
      budget_id: budget.budget_id, provider, provider_limit_microusd: budget.provider_limit_microusd } as const;
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!isNodeError(error) || error.code !== "EEXIST") throw error; }
    await realDirectory(directory, false);
    const records = join(directory, "reservations");
    if (created) {
      await syncDirectory(parent);
      await mkdir(records, { mode: 0o700 });
      await writeExclusive(join(directory, "cap.json"), cap);
    }
    const snapshot = await readChain({ store, budgetId: budget.budget_id, provider });
    if (snapshot.provider_limit_microusd !== budget.provider_limit_microusd) {
      throw new DalError("PROPOSE_BUDGET_CAP_DRIFT", "An initialized provider budget cannot change its cap");
    }
    let total = snapshot.reserved_microusd;
    const { seen, head_sha256: previous } = snapshot;
    if (seen.has(requestDigest)) throw new DalError("PROPOSE_REQUEST_ALREADY_RESERVED", "This request has already been reserved, regardless of its outcome or approval");
    if (budget.reservation_microusd > budget.provider_limit_microusd - total) {
      throw new DalError("PROPOSE_BUDGET_EXCEEDED", "Insufficient approved reservation units");
    }
    const reservation: ProposalBudgetReservation = { ...cap, schema_version: "1.0.0", kind: "reservation",
      reservation_microusd: budget.reservation_microusd, request_digest: requestDigest, approval_id: approvalId,
      sequence: snapshot.sequence + 1, previous_sha256: previous };
    if (!validate(reservation)) throw new Error("Invalid reservation");
    const path = join(records, `${String(reservation.sequence).padStart(16, "0")}-${sha256(canonicalJson(reservation))}.json`);
    await writeExclusive(path, reservation);
    total += budget.reservation_microusd;
    return { reservation, path, reserved_microusd: total, remaining_microusd: budget.provider_limit_microusd - total };
  } catch (error) {
    if (error instanceof DalError) throw error;
    throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget ledger is incomplete, corrupt, or inaccessible; investigate before retrying");
  } finally {
    // Never recursively remove a lock, reclaim a stale one, or remove a replacement lock.
    const current = await lstat(lock);
    if (!current.isDirectory() || current.dev !== ownedLock.dev || current.ino !== ownedLock.ino) {
      throw new DalError("PROPOSE_BUDGET_CORRUPT", "Budget lock ownership changed");
    }
    await rmdir(lock);
    await syncDirectory(parent);
  }
}
