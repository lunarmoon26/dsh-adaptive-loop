import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Mock order/booking service for the tau-style benchmark workspace.
 *
 * The agent drives the workflow ONLY through the typed tools in index.ts;
 * this module is the external state store plus the append-only effect log.
 * It enforces the written policy at the service boundary (e.g. no refund
 * above the order total, no booking change after departure) and can inject
 * simulated outcomes (success / definite failure / timeout-unknown) per
 * effect kind so the loop can exercise retry and idempotency paths.
 * The deterministic grader reads this state — never the agent's own
 * self-reported files.
 */

export type EffectKind = "issue_refund" | "create_return_label" | "change_booking" | "refuse_request";
export type EffectOutcome = "success" | "definite_failure" | "unknown";

export interface OrderRecord {
  status: string;
  total: number;
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

export interface EffectEntry {
  seq: number;
  at: string;
  kind: EffectKind;
  idempotency_key: string;
  outcome: EffectOutcome;
  receipt_sha256: string;
  summary: string;
  params?: Record<string, string | number | boolean>;
}

export interface ServiceEnvironment {
  stateRoot: string;
  /** Simulated outcome per effect kind; default all success. */
  faults: Partial<Record<EffectKind, EffectOutcome>>;
  /** What an 'unknown' effect resolves to when its status is queried. */
  resolutions?: Partial<Record<EffectKind, EffectOutcome>>;
  now?: () => Date;
}

export interface EffectResult {
  outcome: EffectOutcome;
  receipt_sha256: string;
  idempotent: boolean;
  summary: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const STATE_FILE = "state.json";
const EFFECT_LOG = "effects.jsonl";

function paths(env: ServiceEnvironment): { state: string; log: string } {
  const root = resolve(env.stateRoot);
  return { state: join(root, STATE_FILE), log: join(root, EFFECT_LOG) };
}

export function initialState(): ServiceState {
  return { orders: {}, refunds: [], labels: [], bookings: {} };
}

export async function loadState(env: ServiceEnvironment): Promise<ServiceState> {
  try {
    return JSON.parse(await readFile(paths(env).state, "utf8")) as ServiceState;
  } catch {
    return initialState();
  }
}

async function persistState(env: ServiceEnvironment, state: ServiceState): Promise<void> {
  const target = paths(env).state;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function appendEffect(env: ServiceEnvironment, entry: EffectEntry): Promise<void> {
  const target = paths(env).log;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function effectEntries(env: ServiceEnvironment): Promise<EffectEntry[]> {
  try {
    const raw = await readFile(paths(env).log, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as EffectEntry);
  } catch {
    return [];
  }
}

async function findEffect(env: ServiceEnvironment, idempotencyKey: string): Promise<EffectEntry | undefined> {
  const entries = await effectEntries(env);
  let found: EffectEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.idempotency_key === idempotencyKey) {
      found = entries[index];
      break;
    }
  }
  return found;
}

function outcomeOf(env: ServiceEnvironment, kind: EffectKind): EffectOutcome {
  return env.faults[kind] ?? "success";
}

async function performEffect(
  env: ServiceEnvironment,
  kind: EffectKind,
  idempotencyKey: string,
  summary: string,
  apply: (state: ServiceState) => string | null,
  params?: Record<string, string | number | boolean>,
): Promise<EffectResult> {
  const existing = await findEffect(env, idempotencyKey);
  if (existing !== undefined) {
    return {
      outcome: existing.outcome,
      receipt_sha256: existing.receipt_sha256,
      idempotent: true,
      summary: existing.summary,
    };
  }
  const outcome = outcomeOf(env, kind);
  const state = await loadState(env);
  let detail = summary;
  if (outcome === "success") {
    const rejection = apply(state);
    if (rejection !== null) {
      return {
        outcome: "definite_failure",
        receipt_sha256: "",
        idempotent: false,
        summary: rejection,
      };
    }
    await persistState(env, state);
  }
  if (outcome === "unknown") {
    detail = `${summary}; outcome unknown — query effect status by idempotency key before retrying`;
  }
  const entries = await effectEntries(env);
  const receipt = sha256(`${kind}|${idempotencyKey}|${outcome}|${entries.length}`);
  const entry: EffectEntry = {
    seq: entries.length + 1,
    at: (env.now?.() ?? new Date()).toISOString(),
    kind,
    idempotency_key: idempotencyKey,
    outcome,
    receipt_sha256: receipt,
    summary: detail,
    ...(params === undefined ? {} : { params }),
  };
  await appendEffect(env, entry);
  return { outcome, receipt_sha256: receipt, idempotent: false, summary: detail };
}

export async function getOrder(env: ServiceEnvironment, orderId: string): Promise<OrderRecord | null> {
  const state = await loadState(env);
  return state.orders[orderId] ?? null;
}

export async function getBooking(env: ServiceEnvironment, bookingId: string): Promise<BookingRecord | null> {
  const state = await loadState(env);
  return state.bookings[bookingId] ?? null;
}

export async function issueRefund(
  env: ServiceEnvironment,
  input: { order_id: string; amount: number; reason: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "issue_refund", input.idempotency_key, `issue refund ${input.amount} for ${input.order_id}`, (state) => {
    const order = state.orders[input.order_id];
    if (order === undefined) {
      return "refund references an unknown order";
    }
    if (input.amount > order.total) {
      return "refund amount exceeds the order total";
    }
    state.refunds.push({ order: input.order_id, amount: input.amount, reason: input.reason });
    order.status = "refunded";
    return null;
  }, { order_id: input.order_id, amount: input.amount, reason: input.reason });
}

export async function createReturnLabel(
  env: ServiceEnvironment,
  input: { order_id: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "create_return_label", input.idempotency_key, `create return label for ${input.order_id}`, (state) => {
    if (state.orders[input.order_id] === undefined) {
      return "label references an unknown order";
    }
    state.labels.push({ order: input.order_id });
    return null;
  }, { order_id: input.order_id });
}

export async function changeBooking(
  env: ServiceEnvironment,
  input: { booking_id: string; new_route: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "change_booking", input.idempotency_key, `change booking ${input.booking_id} to ${input.new_route}`, (state) => {
    const booking = state.bookings[input.booking_id];
    if (booking === undefined) {
      return "booking does not exist";
    }
    if (booking.status === "departed") {
      return "booking changes are not allowed after departure";
    }
    booking.route = input.new_route;
    booking.changes += 1;
    return null;
  }, { booking_id: input.booking_id, new_route: input.new_route });
}

export async function refuseRequest(
  env: ServiceEnvironment,
  input: { kind: string; target: string; reason: string; idempotency_key: string },
): Promise<EffectResult> {
  return performEffect(env, "refuse_request", input.idempotency_key, `refuse ${input.kind} for ${input.target}: ${input.reason}`, () => null, {
    kind: input.kind,
    target: input.target,
    reason: input.reason,
  });
}

function applyResolvedOperation(state: ServiceState, entry: EffectEntry): string | null {
  const params = entry.params ?? {};
  if (entry.kind === "issue_refund") {
    const order = state.orders[String(params.order_id ?? "")];
    if (order === undefined) return "refund references an unknown order";
    state.refunds.push({
      order: String(params.order_id),
      amount: Number(params.amount ?? 0),
      reason: String(params.reason ?? ""),
    });
    order.status = "refunded";
    return null;
  }
  if (entry.kind === "create_return_label") {
    if (state.orders[String(params.order_id ?? "")] === undefined) return "label references an unknown order";
    state.labels.push({ order: String(params.order_id) });
    return null;
  }
  if (entry.kind === "change_booking") {
    const booking = state.bookings[String(params.booking_id ?? "")];
    if (booking === undefined) return "booking does not exist";
    booking.route = String(params.new_route ?? booking.route);
    booking.changes += 1;
    return null;
  }
  return null;
}

export async function getEffectStatus(
  env: ServiceEnvironment,
  idempotencyKey: string,
): Promise<{ found: boolean; outcome: EffectOutcome | null; receipt_sha256: string | null; summary: string | null }> {
  let entry = await findEffect(env, idempotencyKey);
  if (entry === undefined) {
    return { found: false, outcome: null, receipt_sha256: null, summary: null };
  }
  const foundEntry = entry;
  const resolvedTo = foundEntry.outcome === "unknown" ? env.resolutions?.[foundEntry.kind] : undefined;
  if (resolvedTo !== undefined) {
    const state = await loadState(env);
    let detail = `resolved on status query: effect ${foundEntry.kind} actually ${resolvedTo}`;
    if (resolvedTo === "success") {
      const rejection = applyResolvedOperation(state, foundEntry);
      if (rejection !== null) {
        detail = `resolved on status query: ${rejection}`;
      } else {
        await persistState(env, state);
      }
    }
    const entries = await effectEntries(env);
    const receipt = sha256(`${foundEntry.kind}|${idempotencyKey}|${resolvedTo}|${entries.length}`);
    const resolvedEntry: EffectEntry = {
      seq: entries.length + 1,
      at: (env.now?.() ?? new Date()).toISOString(),
      kind: foundEntry.kind,
      idempotency_key: idempotencyKey,
      outcome: resolvedTo,
      receipt_sha256: receipt,
      summary: detail,
      ...(foundEntry.params === undefined ? {} : { params: foundEntry.params }),
    };
    await appendEffect(env, resolvedEntry);
    return { found: true, outcome: resolvedEntry.outcome, receipt_sha256: resolvedEntry.receipt_sha256, summary: resolvedEntry.summary };
  }
  const latest = entry;
  return { found: true, outcome: latest.outcome, receipt_sha256: latest.receipt_sha256, summary: latest.summary };
}
/**
 * The evaluator-side projection of the service state: applies the workflow
 * output convention (orders keep `status`, refunds keep order/amount/reason,
 * labels keep `order`, bookings keep `route` and `changes`) before the
 * deterministic grader compares against the goal. The agent-facing tools
 * still expose the full internal records (e.g. booking `status` needed to
 * apply the policy).
 */
export function projectServiceState(state: ServiceState): ServiceState {
  const orders: Record<string, OrderRecord> = {};
  for (const [id, order] of Object.entries(state.orders)) {
    orders[id] = { status: order.status, total: order.total };
  }
  const bookings: Record<string, BookingRecord> = {};
  for (const [id, booking] of Object.entries(state.bookings)) {
    bookings[id] = { route: booking.route, changes: booking.changes };
  }
  return { orders, refunds: state.refunds, labels: state.labels, bookings };
}
