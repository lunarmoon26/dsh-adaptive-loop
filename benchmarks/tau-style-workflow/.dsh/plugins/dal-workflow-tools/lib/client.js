import { changeBooking, createReturnLabel, getBooking, getEffectStatus, getOrder, issueRefund, refuseRequest, } from "./service.js";
export function localWorkflowService(env) {
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
export function remoteWorkflowService(serviceUrl) {
    const base = serviceUrl.replace(/\/+$/, "");
    const call = async (operation, body) => {
        const response = await fetch(`${base}/v1/${operation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const value = (await response.json());
        if (!response.ok) {
            throw new Error(value.error ?? `Workflow service returned HTTP ${response.status}`);
        }
        return value;
    };
    return {
        getOrder: async (orderId) => (await call("get_order", { order_id: orderId })).data,
        getBooking: async (bookingId) => (await call("get_booking", { booking_id: bookingId })).data,
        issueRefund: (input) => call("issue_refund", input),
        createReturnLabel: (input) => call("create_return_label", input),
        changeBooking: (input) => call("change_booking", input),
        refuseRequest: (input) => call("refuse_request", input),
        getEffectStatus: (idempotencyKey) => call("get_effect_status", { idempotency_key: idempotencyKey }),
    };
}
//# sourceMappingURL=client.js.map