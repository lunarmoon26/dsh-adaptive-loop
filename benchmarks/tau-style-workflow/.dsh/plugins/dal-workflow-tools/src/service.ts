import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Crash-safe mock order/booking service for the tau-style benchmark.
 *
 * `effects.jsonl` is the sole source of truth. Its first entry is an immutable
 * seed snapshot and every later entry is an attempted business effect. Current
 * state is derived by replaying successful effects, so there is no state-write /
 * effect-append crash window. Missing, truncated, malformed, out-of-sequence,
 * or digest-invalid journals fail closed.
 */

export type EffectKind = "issue_refund" | "create_return_label" | "change_booking" | "refuse_request";
export type EffectOutcome = "success" | "definite_failure" | "unknown";
export type EffectParams = Record<string, string | number | boolean>;

export interface OrderRecord {
  status: string;
  total?: number;
  days_since_delivery?: number;
  items?: string[];
}

export interface BookingRecord {
  route: string;
  date?: string;
  status?: string;
  seats?: number;
  changes: number;
}

export interface ServiceState {
  orders: Record<string, OrderRecord>;
  refunds: Array<{ order: string; amount: number; reason: string }>;
  labels: Array<{ order: string }>;
  bookings: Record<string, BookingRecord>;
}

export interface SeedEntry {
  event: "seed";
  seq: 0;
  at: string;
  state: ServiceState;
  entry_sha256: string;
}

export interface EffectEntry {
  event: "effect";
  seq: number;
  at: string;
  kind: EffectKind;
  idempotency_key: string;
  outcome: EffectOutcome;
  receipt_sha256: string;
  summary: string;
  params: EffectParams;
  entry_sha256: string;
}

export type ServiceJournalEntry = SeedEntry | EffectEntry;

export interface ServiceEnvironment {
  stateRoot: string;
  /** Simulated outcome per effect kind; default all success. */
  faults: Partial<Record<EffectKind, EffectOutcome>>;
  /** What an unknown effect resolves to when its status is queried. */
  resolutions?: Partial<Record<EffectKind, Exclude<EffectOutcome, "unknown">>>;
  now?: () => Date;
}

export interface EffectResult {
  outcome: EffectOutcome;
  receipt_sha256: string;
  idempotent: boolean;
  summary: string;
}

export interface ServiceSnapshot {
  state: ServiceState;
  effects: EffectEntry[];
  journal_sha256: string;
}

export class ServiceJournalError extends Error {
  constructor(
    readonly code:
      | "SERVICE_JOURNAL_MISSING"
      | "SERVICE_JOURNAL_CORRUPT"
      | "SERVICE_IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ServiceJournalError";
  }
}

const JOURNAL_FILE = "effects.jsonl";
const queues = new Map<string, Promise<void>>();

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
  };
  return JSON.stringify(visit(value));
}

function journalPath(env: ServiceEnvironment): string {
  return join(resolve(env.stateRoot), JOURNAL_FILE);
}

export function initialState(): ServiceState {
  return { orders: {}, refunds: [], labels: [], bookings: {} };
}

function entryDigest(entry: object): string {
  return sha256(stableJson(entry));
}

function seedEntry(env: ServiceEnvironment, state: ServiceState): SeedEntry {
  const unsigned: Omit<SeedEntry, "entry_sha256"> = {
    event: "seed",
    seq: 0,
    at: (env.now?.() ?? new Date()).toISOString(),
    state: structuredClone(state),
  };
  return { ...unsigned, entry_sha256: entryDigest(unsigned) };
}

/** Atomically replace the journal with one seed entry before an attempt starts. */
export async function initializeService(env: ServiceEnvironment, state: ServiceState): Promise<void> {
  await serialized(env, async () => {
    const target = journalPath(env);
    const directory = dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(seedEntry(env, state))}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  });
}

function assertRecord(value: unknown, index: number): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} is not an object`);
  }
}

async function readJournal(env: ServiceEnvironment): Promise<{ raw: string; entries: ServiceJournalEntry[] }> {
  let raw: string;
  try {
    raw = await readFile(journalPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ServiceJournalError("SERVICE_JOURNAL_MISSING", "Service journal is not initialized");
    }
    throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal is not readable");
  }
  if (raw === "" || !raw.endsWith("\n")) {
    throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal is empty or has a partial final entry");
  }
  const entries: ServiceJournalEntry[] = [];
  const lines = raw.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} is not valid JSON`);
    }
    assertRecord(parsed, index);
    if (parsed.seq !== index) {
      throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} has a non-contiguous sequence`);
    }
    if ((index === 0 && parsed.event !== "seed") || (index > 0 && parsed.event !== "effect")) {
      throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} has the wrong event kind`);
    }
    if (typeof parsed.entry_sha256 !== "string") {
      throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} has no digest`);
    }
    const { entry_sha256: recordedDigest, ...unsigned } = parsed;
    if (entryDigest(unsigned) !== recordedDigest) {
      throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} failed its digest check`);
    }
    entries.push(parsed as unknown as ServiceJournalEntry);
  }
  return { raw, entries };
}

function applyOperation(state: ServiceState, kind: EffectKind, params: EffectParams): string | null {
  if (kind === "issue_refund") {
    const orderId = String(params.order_id ?? "");
    const order = state.orders[orderId];
    if (order === undefined) return "refund references an unknown order";
    const amount = Number(params.amount ?? 0);
    if (amount > (order.total ?? 0)) return "refund amount exceeds the order total";
    state.refunds.push({ order: orderId, amount, reason: String(params.reason ?? "") });
    if (amount >= (order.total ?? 0)) order.status = "refunded";
    return null;
  }
  if (kind === "create_return_label") {
    const orderId = String(params.order_id ?? "");
    if (state.orders[orderId] === undefined) return "label references an unknown order";
    state.labels.push({ order: orderId });
    return null;
  }
  if (kind === "change_booking") {
    const bookingId = String(params.booking_id ?? "");
    const booking = state.bookings[bookingId];
    if (booking === undefined) return "booking does not exist";
    if (booking.status === "departed") return "booking changes are not allowed after departure";
    booking.route = String(params.new_route ?? booking.route);
    booking.changes += 1;
    return null;
  }
  return null;
}

function replay(entries: readonly ServiceJournalEntry[]): { state: ServiceState; effects: EffectEntry[] } {
  const seed = entries[0];
  if (seed?.event !== "seed") {
    throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal has no seed entry");
  }
  const state = structuredClone(seed.state);
  const effects = entries.slice(1) as EffectEntry[];
  for (const effect of effects) {
    if (effect.outcome !== "success") continue;
    const rejection = applyOperation(state, effect.kind, effect.params);
    if (rejection !== null) {
      throw new ServiceJournalError(
        "SERVICE_JOURNAL_CORRUPT",
        `Successful effect ${effect.seq} cannot be replayed: ${rejection}`,
      );
    }
  }
  return { state, effects };
}

async function loadSnapshotUnlocked(env: ServiceEnvironment): Promise<ServiceSnapshot> {
  const journal = await readJournal(env);
  const projected = replay(journal.entries);
  return { ...projected, journal_sha256: sha256(journal.raw) };
}

export async function loadSnapshot(env: ServiceEnvironment): Promise<ServiceSnapshot> {
  return serialized(env, () => loadSnapshotUnlocked(env));
}

export async function loadState(env: ServiceEnvironment): Promise<ServiceState> {
  return (await loadSnapshot(env)).state;
}

export async function loadEffectEntries(env: ServiceEnvironment): Promise<EffectEntry[]> {
  return (await loadSnapshot(env)).effects;
}

async function appendEffect(
  env: ServiceEnvironment,
  input: {
    kind: EffectKind;
    idempotencyKey: string;
    outcome: EffectOutcome;
    summary: string;
    params: EffectParams;
    seq: number;
  },
): Promise<EffectEntry> {
  const receipt = sha256(stableJson({
    kind: input.kind,
    idempotency_key: input.idempotencyKey,
    outcome: input.outcome,
    params: input.params,
    seq: input.seq,
  }));
  const unsigned: Omit<EffectEntry, "entry_sha256"> = {
    event: "effect",
    seq: input.seq,
    at: (env.now?.() ?? new Date()).toISOString(),
    kind: input.kind,
    idempotency_key: input.idempotencyKey,
    outcome: input.outcome,
    receipt_sha256: receipt,
    summary: input.summary,
    params: input.params,
  };
  const entry: EffectEntry = { ...unsigned, entry_sha256: entryDigest(unsigned) };
  const handle = await open(journalPath(env), "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return entry;
}

async function serialized<T>(env: ServiceEnvironment, operation: () => Promise<T>): Promise<T> {
  const key = resolve(env.stateRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const queued = previous.then(() => current);
  queues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

function latestEffect(effects: readonly EffectEntry[], idempotencyKey: string): EffectEntry | undefined {
  return [...effects].reverse().find((entry) => entry.idempotency_key === idempotencyKey);
}

function sameLogicalEffect(existing: EffectEntry, kind: EffectKind, params: EffectParams): boolean {
  return existing.kind === kind && stableJson(existing.params) === stableJson(params);
}

async function performEffect(
  env: ServiceEnvironment,
  kind: EffectKind,
  idempotencyKey: string,
  summary: string,
  params: EffectParams,
): Promise<EffectResult> {
  return serialized(env, async () => {
    const snapshot = await loadSnapshotUnlocked(env);
    const existing = latestEffect(snapshot.effects, idempotencyKey);
    if (existing !== undefined) {
      if (!sameLogicalEffect(existing, kind, params)) {
        throw new ServiceJournalError(
          "SERVICE_IDEMPOTENCY_CONFLICT",
          `Idempotency key ${idempotencyKey} was already used for a different effect`,
        );
      }
      return {
        outcome: existing.outcome,
        receipt_sha256: existing.receipt_sha256,
        idempotent: true,
        summary: existing.summary,
      };
    }

    let outcome = env.faults[kind] ?? "success";
    let detail = summary;
    if (outcome === "success") {
      const trial = structuredClone(snapshot.state);
      const rejection = applyOperation(trial, kind, params);
      if (rejection !== null) {
        outcome = "definite_failure";
        detail = rejection;
      }
    } else if (outcome === "unknown") {
      detail = `${summary}; outcome unknown — query effect status by idempotency key before retrying`;
    }
    const entry = await appendEffect(env, {
      kind,
      idempotencyKey,
      outcome,
      summary: detail,
      params,
      seq: snapshot.effects.length + 1,
    });
    return { outcome, receipt_sha256: entry.receipt_sha256, idempotent: false, summary: detail };
  });
}

export async function getOrder(env: ServiceEnvironment, orderId: string): Promise<OrderRecord | null> {
  return (await loadState(env)).orders[orderId] ?? null;
}

export async function getBooking(env: ServiceEnvironment, bookingId: string): Promise<BookingRecord | null> {
  return (await loadState(env)).bookings[bookingId] ?? null;
}

export async function issueRefund(
  env: ServiceEnvironment,
  input: { order_id: string; amount: number; reason: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "issue_refund", input.idempotency_key, `issue refund ${input.amount} for ${input.order_id}`, {
    order_id: input.order_id,
    amount: input.amount,
    reason: input.reason,
  });
}

export async function createReturnLabel(
  env: ServiceEnvironment,
  input: { order_id: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "create_return_label", input.idempotency_key, `create return label for ${input.order_id}`, {
    order_id: input.order_id,
  });
}

export async function changeBooking(
  env: ServiceEnvironment,
  input: { booking_id: string; new_route: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "change_booking", input.idempotency_key, `change booking ${input.booking_id} to ${input.new_route}`, {
    booking_id: input.booking_id,
    new_route: input.new_route,
  });
}

export async function refuseRequest(
  env: ServiceEnvironment,
  input: { kind: string; target: string; reason: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "refuse_request", input.idempotency_key, `refuse ${input.kind} for ${input.target}: ${input.reason}`, {
    kind: input.kind,
    target: input.target,
    reason: input.reason,
  });
}

export async function getEffectStatus(
  env: ServiceEnvironment,
  idempotencyKey: string,
): Promise<{ found: boolean; outcome: EffectOutcome | null; receipt_sha256: string | null; summary: string | null }> {
  return serialized(env, async () => {
    const snapshot = await loadSnapshotUnlocked(env);
    const existing = latestEffect(snapshot.effects, idempotencyKey);
    if (existing === undefined) {
      return { found: false, outcome: null, receipt_sha256: null, summary: null };
    }
    const resolution = existing.outcome === "unknown" ? env.resolutions?.[existing.kind] : undefined;
    if (resolution === undefined) {
      return {
        found: true,
        outcome: existing.outcome,
        receipt_sha256: existing.receipt_sha256,
        summary: existing.summary,
      };
    }

    let outcome: EffectOutcome = resolution;
    let detail = `resolved on status query: effect ${existing.kind} actually ${resolution}`;
    if (outcome === "success") {
      const trial = structuredClone(snapshot.state);
      const rejection = applyOperation(trial, existing.kind, existing.params);
      if (rejection !== null) {
        outcome = "definite_failure";
        detail = `resolved on status query: ${rejection}`;
      }
    }
    const resolved = await appendEffect(env, {
      kind: existing.kind,
      idempotencyKey,
      outcome,
      summary: detail,
      params: existing.params,
      seq: snapshot.effects.length + 1,
    });
    return {
      found: true,
      outcome: resolved.outcome,
      receipt_sha256: resolved.receipt_sha256,
      summary: resolved.summary,
    };
  });
}

/** Evaluator-side state projection used before deterministic grading. */
export function projectServiceState(state: ServiceState): ServiceState {
  const orders: Record<string, OrderRecord> = {};
  for (const [id, order] of Object.entries(state.orders)) orders[id] = { status: order.status };
  const bookings: Record<string, BookingRecord> = {};
  for (const [id, booking] of Object.entries(state.bookings)) {
    bookings[id] = { route: booking.route, changes: booking.changes };
  }
  return { orders, refunds: state.refunds, labels: state.labels, bookings };
}
