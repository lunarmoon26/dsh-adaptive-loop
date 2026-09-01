import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export class ServiceJournalError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ServiceJournalError";
    }
}
const JOURNAL_FILE = "effects.jsonl";
const queues = new Map();
export function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
function stableJson(value) {
    const visit = (entry) => {
        if (entry === null || typeof entry !== "object")
            return entry;
        if (Array.isArray(entry))
            return entry.map(visit);
        const record = entry;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
    };
    return JSON.stringify(visit(value));
}
function journalPath(env) {
    return join(resolve(env.stateRoot), JOURNAL_FILE);
}
export function initialState() {
    return { orders: {}, refunds: [], labels: [], bookings: {} };
}
function entryDigest(entry) {
    return sha256(stableJson(entry));
}
function seedEntry(env, state) {
    const unsigned = {
        event: "seed",
        seq: 0,
        at: (env.now?.() ?? new Date()).toISOString(),
        state: structuredClone(state),
    };
    return { ...unsigned, entry_sha256: entryDigest(unsigned) };
}
/** Atomically replace the journal with one seed entry before an attempt starts. */
export async function initializeService(env, state) {
    await serialized(env, async () => {
        const target = journalPath(env);
        const directory = dirname(target);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(seedEntry(env, state))}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, target);
        const directoryHandle = await open(directory, "r");
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    });
}
function assertRecord(value, index) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Journal entry ${index} is not an object`);
    }
}
async function readJournal(env) {
    let raw;
    try {
        raw = await readFile(journalPath(env), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new ServiceJournalError("SERVICE_JOURNAL_MISSING", "Service journal is not initialized");
        }
        throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal is not readable");
    }
    if (raw === "" || !raw.endsWith("\n")) {
        throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal is empty or has a partial final entry");
    }
    const entries = [];
    const lines = raw.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
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
        entries.push(parsed);
    }
    return { raw, entries };
}
function applyOperation(state, kind, params) {
    if (kind === "issue_refund") {
        const orderId = String(params.order_id ?? "");
        const order = state.orders[orderId];
        if (order === undefined)
            return "refund references an unknown order";
        const amount = Number(params.amount ?? 0);
        if (amount > (order.total ?? 0))
            return "refund amount exceeds the order total";
        state.refunds.push({ order: orderId, amount, reason: String(params.reason ?? "") });
        if (amount >= (order.total ?? 0))
            order.status = "refunded";
        return null;
    }
    if (kind === "create_return_label") {
        const orderId = String(params.order_id ?? "");
        if (state.orders[orderId] === undefined)
            return "label references an unknown order";
        state.labels.push({ order: orderId });
        return null;
    }
    if (kind === "change_booking") {
        const bookingId = String(params.booking_id ?? "");
        const booking = state.bookings[bookingId];
        if (booking === undefined)
            return "booking does not exist";
        if (booking.status === "departed")
            return "booking changes are not allowed after departure";
        booking.route = String(params.new_route ?? booking.route);
        booking.changes += 1;
        return null;
    }
    return null;
}
function replay(entries) {
    const seed = entries[0];
    if (seed?.event !== "seed") {
        throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", "Service journal has no seed entry");
    }
    const state = structuredClone(seed.state);
    const effects = entries.slice(1);
    for (const effect of effects) {
        if (effect.outcome !== "success")
            continue;
        const rejection = applyOperation(state, effect.kind, effect.params);
        if (rejection !== null) {
            throw new ServiceJournalError("SERVICE_JOURNAL_CORRUPT", `Successful effect ${effect.seq} cannot be replayed: ${rejection}`);
        }
    }
    return { state, effects };
}
async function loadSnapshotUnlocked(env) {
    const journal = await readJournal(env);
    const projected = replay(journal.entries);
    return { ...projected, journal_sha256: sha256(journal.raw) };
}
export async function loadSnapshot(env) {
    return serialized(env, () => loadSnapshotUnlocked(env));
}
export async function loadState(env) {
    return (await loadSnapshot(env)).state;
}
export async function loadEffectEntries(env) {
    return (await loadSnapshot(env)).effects;
}
async function appendEffect(env, input) {
    const receipt = sha256(stableJson({
        kind: input.kind,
        idempotency_key: input.idempotencyKey,
        outcome: input.outcome,
        params: input.params,
        seq: input.seq,
    }));
    const unsigned = {
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
    const entry = { ...unsigned, entry_sha256: entryDigest(unsigned) };
    const handle = await open(journalPath(env), "a", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return entry;
}
async function serialized(env, operation) {
    const key = resolve(env.stateRoot);
    const previous = queues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolveQueue) => {
        release = resolveQueue;
    });
    const queued = previous.then(() => current);
    queues.set(key, queued);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (queues.get(key) === queued)
            queues.delete(key);
    }
}
function latestEffect(effects, idempotencyKey) {
    return [...effects].reverse().find((entry) => entry.idempotency_key === idempotencyKey);
}
function sameLogicalEffect(existing, kind, params) {
    return existing.kind === kind && stableJson(existing.params) === stableJson(params);
}
async function performEffect(env, kind, idempotencyKey, summary, params) {
    return serialized(env, async () => {
        const snapshot = await loadSnapshotUnlocked(env);
        const existing = latestEffect(snapshot.effects, idempotencyKey);
        if (existing !== undefined) {
            if (!sameLogicalEffect(existing, kind, params)) {
                throw new ServiceJournalError("SERVICE_IDEMPOTENCY_CONFLICT", `Idempotency key ${idempotencyKey} was already used for a different effect`);
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
        }
        else if (outcome === "unknown") {
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
export async function getOrder(env, orderId) {
    return (await loadState(env)).orders[orderId] ?? null;
}
export async function getBooking(env, bookingId) {
    return (await loadState(env)).bookings[bookingId] ?? null;
}
export async function issueRefund(env, input) {
    return performEffect(env, "issue_refund", input.idempotency_key, `issue refund ${input.amount} for ${input.order_id}`, {
        order_id: input.order_id,
        amount: input.amount,
        reason: input.reason,
    });
}
export async function createReturnLabel(env, input) {
    return performEffect(env, "create_return_label", input.idempotency_key, `create return label for ${input.order_id}`, {
        order_id: input.order_id,
    });
}
export async function changeBooking(env, input) {
    return performEffect(env, "change_booking", input.idempotency_key, `change booking ${input.booking_id} to ${input.new_route}`, {
        booking_id: input.booking_id,
        new_route: input.new_route,
    });
}
export async function refuseRequest(env, input) {
    return performEffect(env, "refuse_request", input.idempotency_key, `refuse ${input.kind} for ${input.target}: ${input.reason}`, {
        kind: input.kind,
        target: input.target,
        reason: input.reason,
    });
}
export async function getEffectStatus(env, idempotencyKey) {
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
        let outcome = resolution;
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
export function projectServiceState(state) {
    const orders = {};
    for (const [id, order] of Object.entries(state.orders))
        orders[id] = { status: order.status };
    const bookings = {};
    for (const [id, booking] of Object.entries(state.bookings)) {
        bookings[id] = { route: booking.route, changes: booking.changes };
    }
    return { orders, refunds: state.refunds, labels: state.labels, bookings };
}
//# sourceMappingURL=service.js.map