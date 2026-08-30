import { createHash } from "node:crypto";
import { mkdir, readFile, rename, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
const STATE_FILE = "state.json";
const EFFECT_LOG = "effects.jsonl";
function paths(env) {
    const root = resolve(env.stateRoot);
    return { state: join(root, STATE_FILE), log: join(root, EFFECT_LOG) };
}
export function initialState() {
    return { orders: {}, refunds: [], labels: [], bookings: {} };
}
export async function loadState(env) {
    try {
        return JSON.parse(await readFile(paths(env).state, "utf8"));
    }
    catch {
        return initialState();
    }
}
async function persistState(env, state) {
    const target = paths(env).state;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, target);
}
async function appendEffect(env, entry) {
    const target = paths(env).log;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "a", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function effectEntries(env) {
    try {
        const raw = await readFile(paths(env).log, "utf8");
        return raw
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
async function findEffect(env, idempotencyKey) {
    const entries = await effectEntries(env);
    let found;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].idempotency_key === idempotencyKey) {
            found = entries[index];
            break;
        }
    }
    return found;
}
function outcomeOf(env, kind) {
    return env.faults[kind] ?? "success";
}
async function performEffect(env, kind, idempotencyKey, summary, apply) {
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
    const entry = {
        seq: entries.length + 1,
        at: (env.now?.() ?? new Date()).toISOString(),
        kind,
        idempotency_key: idempotencyKey,
        outcome,
        receipt_sha256: receipt,
        summary: detail,
    };
    await appendEffect(env, entry);
    return { outcome, receipt_sha256: receipt, idempotent: false, summary: detail };
}
export async function getOrder(env, orderId) {
    const state = await loadState(env);
    return state.orders[orderId] ?? null;
}
export async function getBooking(env, bookingId) {
    const state = await loadState(env);
    return state.bookings[bookingId] ?? null;
}
export async function issueRefund(env, input) {
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
    });
}
export async function createReturnLabel(env, input) {
    return performEffect(env, "create_return_label", input.idempotency_key, `create return label for ${input.order_id}`, (state) => {
        if (state.orders[input.order_id] === undefined) {
            return "label references an unknown order";
        }
        state.labels.push({ order: input.order_id });
        return null;
    });
}
export async function changeBooking(env, input) {
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
    });
}
export async function refuseRequest(env, input) {
    return performEffect(env, "refuse_request", input.idempotency_key, `refuse ${input.kind} for ${input.target}: ${input.reason}`, () => null);
}
export async function getEffectStatus(env, idempotencyKey) {
    const entry = await findEffect(env, idempotencyKey);
    if (entry === undefined) {
        return { found: false, outcome: null, receipt_sha256: null, summary: null };
    }
    return { found: true, outcome: entry.outcome, receipt_sha256: entry.receipt_sha256, summary: entry.summary };
}
/**
 * The evaluator-side projection of the service state: applies the workflow
 * output convention (orders keep `status`, refunds keep order/amount/reason,
 * labels keep `order`, bookings keep `route` and `changes`) before the
 * deterministic grader compares against the goal. The agent-facing tools
 * still expose the full internal records (e.g. booking `status` needed to
 * apply the policy).
 */
export function projectServiceState(state) {
    const orders = {};
    for (const [id, order] of Object.entries(state.orders)) {
        orders[id] = { status: order.status, total: order.total };
    }
    const bookings = {};
    for (const [id, booking] of Object.entries(state.bookings)) {
        bookings[id] = { route: booking.route, changes: booking.changes };
    }
    return { orders, refunds: state.refunds, labels: state.labels, bookings };
}
//# sourceMappingURL=service.js.map