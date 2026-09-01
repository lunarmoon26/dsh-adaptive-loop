import {
  changeBooking,
  createReturnLabel,
  getBooking,
  getEffectStatus,
  getOrder,
  issueRefund,
  refuseRequest,
  type BookingRecord,
  type EffectResult,
  type OrderRecord,
  type ServiceEnvironment,
} from "./service.js";

export interface WorkflowServiceClient {
  getOrder(orderId: string): Promise<OrderRecord | null>;
  getBooking(bookingId: string): Promise<BookingRecord | null>;
  issueRefund(input: { order_id: string; amount: number; reason: string; idempotency_key: string }): Promise<EffectResult>;
  createReturnLabel(input: { order_id: string; idempotency_key: string }): Promise<EffectResult>;
  changeBooking(input: { booking_id: string; new_route: string; idempotency_key: string }): Promise<EffectResult>;
  refuseRequest(input: { kind: string; target: string; reason: string; idempotency_key: string }): Promise<EffectResult>;
  getEffectStatus(idempotencyKey: string): Promise<{
    found: boolean;
    outcome: "success" | "definite_failure" | "unknown" | null;
    receipt_sha256: string | null;
    summary: string | null;
  }>;
}

export function localWorkflowService(env: ServiceEnvironment): WorkflowServiceClient {
  return {
    getOrder: (orderId) => getOrder(env, orderId),
    getBooking: (bookingId) => getBooking(env, bookingId),
    issueRefund: (input) => issueRefund(env, input),
    createReturnLabel: (input) => createReturnLabel(env, input),
    changeBooking: (input) => changeBooking(env, input),
    refuseRequest: (input) => refuseRequest(env, input),
    getEffectStatus: (idempotencyKey) => getEffectStatus(env, idempotencyKey),
  };
}

export function remoteWorkflowService(serviceUrl: string): WorkflowServiceClient {
  const base = serviceUrl.replace(/\/+$/, "");
  const call = async <T>(operation: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${base}/v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(value.error ?? `Workflow service returned HTTP ${response.status}`);
    }
    return value;
  };
  return {
    getOrder: async (orderId) => (await call<{ data: OrderRecord | null }>("get_order", { order_id: orderId })).data,
    getBooking: async (bookingId) =>
      (await call<{ data: BookingRecord | null }>("get_booking", { booking_id: bookingId })).data,
    issueRefund: (input) => call("issue_refund", input),
    createReturnLabel: (input) => call("create_return_label", input),
    changeBooking: (input) => call("change_booking", input),
    refuseRequest: (input) => call("refuse_request", input),
    getEffectStatus: (idempotencyKey) => call("get_effect_status", { idempotency_key: idempotencyKey }),
  };
}
