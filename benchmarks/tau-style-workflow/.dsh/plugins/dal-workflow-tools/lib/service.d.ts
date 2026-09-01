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
    refunds: Array<{
        order: string;
        amount: number;
        reason: string;
    }>;
    labels: Array<{
        order: string;
    }>;
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
export declare class ServiceJournalError extends Error {
    readonly code: "SERVICE_JOURNAL_MISSING" | "SERVICE_JOURNAL_CORRUPT" | "SERVICE_IDEMPOTENCY_CONFLICT";
    constructor(code: "SERVICE_JOURNAL_MISSING" | "SERVICE_JOURNAL_CORRUPT" | "SERVICE_IDEMPOTENCY_CONFLICT", message: string);
}
export declare function sha256(text: string): string;
export declare function initialState(): ServiceState;
/** Atomically replace the journal with one seed entry before an attempt starts. */
export declare function initializeService(env: ServiceEnvironment, state: ServiceState): Promise<void>;
export declare function loadSnapshot(env: ServiceEnvironment): Promise<ServiceSnapshot>;
export declare function loadState(env: ServiceEnvironment): Promise<ServiceState>;
export declare function loadEffectEntries(env: ServiceEnvironment): Promise<EffectEntry[]>;
export declare function getOrder(env: ServiceEnvironment, orderId: string): Promise<OrderRecord | null>;
export declare function getBooking(env: ServiceEnvironment, bookingId: string): Promise<BookingRecord | null>;
export declare function issueRefund(env: ServiceEnvironment, input: {
    order_id: string;
    amount: number;
    reason: string;
    idempotency_key: string;
}): Promise<EffectResult>;
export declare function createReturnLabel(env: ServiceEnvironment, input: {
    order_id: string;
    idempotency_key: string;
}): Promise<EffectResult>;
export declare function changeBooking(env: ServiceEnvironment, input: {
    booking_id: string;
    new_route: string;
    idempotency_key: string;
}): Promise<EffectResult>;
export declare function refuseRequest(env: ServiceEnvironment, input: {
    kind: string;
    target: string;
    reason: string;
    idempotency_key: string;
}): Promise<EffectResult>;
export declare function getEffectStatus(env: ServiceEnvironment, idempotencyKey: string): Promise<{
    found: boolean;
    outcome: EffectOutcome | null;
    receipt_sha256: string | null;
    summary: string | null;
}>;
/** Evaluator-side state projection used before deterministic grading. */
export declare function projectServiceState(state: ServiceState): ServiceState;
