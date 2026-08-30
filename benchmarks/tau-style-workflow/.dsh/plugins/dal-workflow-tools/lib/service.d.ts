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
export declare function sha256(text: string): string;
export declare function initialState(): ServiceState;
export declare function loadState(env: ServiceEnvironment): Promise<ServiceState>;
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
/**
 * The evaluator-side projection of the service state: applies the workflow
 * output convention (orders keep `status`, refunds keep order/amount/reason,
 * labels keep `order`, bookings keep `route` and `changes`) before the
 * deterministic grader compares against the goal. The agent-facing tools
 * still expose the full internal records (e.g. booking `status` needed to
 * apply the policy).
 */
export declare function projectServiceState(state: ServiceState): ServiceState;
