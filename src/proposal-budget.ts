import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { DalError, isNodeError } from "./errors.js";
import { canonicalJson, sha256 } from "./json.js";

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
    if ((await readdir(directory)).sort().join(",") !== "cap.json,reservations") throw new Error("Missing or unknown ledger entries");
    await realDirectory(records, false);
    const storedCap = await readRecord(join(directory, "cap.json"), validate);
    if (storedCap.kind !== "cap" || storedCap.budget_id !== budget.budget_id || storedCap.provider !== provider) throw new Error("Cap identity mismatch");
    if (storedCap.provider_limit_microusd !== budget.provider_limit_microusd) {
      throw new DalError("PROPOSE_BUDGET_CAP_DRIFT", "An initialized provider budget cannot change its cap");
    }
    let total = 0;
    let previous = sha256(canonicalJson(storedCap));
    const seen = new Set<string>();
    const names = (await readdir(records)).sort();
    for (const [index, name] of names.entries()) {
      if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unknown reservation entry");
      const record = await readRecord(join(records, name), validate);
      const digest = sha256(canonicalJson(record));
      if (record.kind !== "reservation" || record.budget_id !== budget.budget_id || record.provider !== provider ||
          record.provider_limit_microusd !== budget.provider_limit_microusd || record.sequence !== index + 1 ||
          record.previous_sha256 !== previous || name !== `${String(index + 1).padStart(16, "0")}-${digest}.json` ||
          seen.has(record.request_digest as string)) throw new Error("Reservation chain mismatch");
      const amount = record.reservation_microusd as number;
      if (amount > budget.provider_limit_microusd - total) throw new Error("Ledger exceeds cap");
      total += amount;
      seen.add(record.request_digest as string);
      previous = digest;
    }
    if (seen.has(requestDigest)) throw new DalError("PROPOSE_REQUEST_ALREADY_RESERVED", "This request has already been reserved, regardless of its outcome or approval");
    if (budget.reservation_microusd > budget.provider_limit_microusd - total) {
      throw new DalError("PROPOSE_BUDGET_EXCEEDED", "Insufficient approved reservation units");
    }
    const reservation: ProposalBudgetReservation = { ...cap, schema_version: "1.0.0", kind: "reservation",
      reservation_microusd: budget.reservation_microusd, request_digest: requestDigest, approval_id: approvalId,
      sequence: names.length + 1, previous_sha256: previous };
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
