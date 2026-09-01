import { type BookingRecord, type EffectResult, type OrderRecord, type ServiceEnvironment } from "./service.js";
export interface WorkflowServiceClient {
    getOrder(orderId: string): Promise<OrderRecord | null>;
    getBooking(bookingId: string): Promise<BookingRecord | null>;
    issueRefund(input: {
        order_id: string;
        amount: number;
        reason: string;
        idempotency_key: string;
    }): Promise<EffectResult>;
    createReturnLabel(input: {
        order_id: string;
        idempotency_key: string;
    }): Promise<EffectResult>;
    changeBooking(input: {
        booking_id: string;
        new_route: string;
        idempotency_key: string;
    }): Promise<EffectResult>;
    refuseRequest(input: {
        kind: string;
        target: string;
        reason: string;
        idempotency_key: string;
    }): Promise<EffectResult>;
    getEffectStatus(idempotencyKey: string): Promise<{
        found: boolean;
        outcome: "success" | "definite_failure" | "unknown" | null;
        receipt_sha256: string | null;
        summary: string | null;
    }>;
}
export declare function localWorkflowService(env: ServiceEnvironment): WorkflowServiceClient;
export declare function remoteWorkflowService(serviceUrl: string): WorkflowServiceClient;
