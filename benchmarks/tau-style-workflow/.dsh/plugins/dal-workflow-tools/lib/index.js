import { defineTool } from "@deepseek-ai/dsh-tools";
import { changeBooking, createReturnLabel, getBooking, getEffectStatus, getOrder, issueRefund, refuseRequest, } from "./service.js";
/**
 * Typed domain tools for the tau-style benchmark workspace: the agent
 * operates the mock order/booking service ONLY through these tools, and the
 * deterministic grader reads the service state — never the agent's own
 * files. Tool connectivity is not authority: every effect carries an
 * idempotency key and lands in the append-only effect log, so retries,
 * unknown outcomes, and compensating checks are observable.
 */
export const name = "dal-workflow-tools";
export const inject = ["tools"];
export function apply(ctx, config) {
    const env = { stateRoot: config.stateRoot, faults: config.faults ?? {} };
    ctx.tools.register(defineTool({
        name: "get_order",
        description: "Read one order from the mock order service by id.",
        parameters: {
            order_id: { type: "string", required: true, description: "Order id, e.g. o-1001." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    found: { type: "boolean", required: true },
                    data: { type: "json", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: value.found ? JSON.stringify(value.data) : "Order not found." }],
        },
        async execute(args) {
            const { order_id } = args;
            const order = await getOrder(env, order_id);
            const data = order === null ? null : JSON.parse(JSON.stringify(order));
            return { found: order !== null, data };
        },
    }));
    ctx.tools.register(defineTool({
        name: "get_booking",
        description: "Read one booking from the mock booking service by id.",
        parameters: {
            booking_id: { type: "string", required: true, description: "Booking id, e.g. b-5001." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    found: { type: "boolean", required: true },
                    data: { type: "json", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: value.found ? JSON.stringify(value.data) : "Booking not found." }],
        },
        async execute(args) {
            const { booking_id } = args;
            const booking = await getBooking(env, booking_id);
            const data = booking === null ? null : JSON.parse(JSON.stringify(booking));
            return { found: booking !== null, data };
        },
    }));
    ctx.tools.register(defineTool({
        name: "issue_refund",
        description: "Issue a refund against an order in the mock service. The service enforces the written policy (unknown order, amount above total). Always pass a unique idempotency_key per logical refund so retries cannot double-apply. May return 'unknown' when the outcome cannot be observed; in that case query get_effect_status with the same key before retrying.",
        parameters: {
            order_id: { type: "string", required: true, description: "Order id." },
            amount: { type: "number", required: true, description: "Refund amount." },
            reason: { type: "string", required: true, description: "Reason code, e.g. damaged." },
            idempotency_key: { type: "string", required: true, description: "Stable unique key for this refund attempt." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    outcome: { type: "string", required: true },
                    receipt_sha256: { type: "string", required: true },
                    idempotent: { type: "boolean", required: true },
                    summary: { type: "string", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: `${value.outcome}${value.idempotent ? " (idempotent replay)" : ""}: ${value.summary}` }],
        },
        async execute(args) {
            const input = args;
            const result = await issueRefund(env, input);
            return { ...result, idempotency_key: input.idempotency_key };
        },
    }));
    ctx.tools.register(defineTool({
        name: "create_return_label",
        description: "Create a return label for an order in the mock service. Full refunds require a label; pass a stable idempotency_key.",
        parameters: {
            order_id: { type: "string", required: true, description: "Order id." },
            idempotency_key: { type: "string", required: true, description: "Stable unique key for this label." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    outcome: { type: "string", required: true },
                    receipt_sha256: { type: "string", required: true },
                    idempotent: { type: "boolean", required: true },
                    summary: { type: "string", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: `${value.outcome}${value.idempotent ? " (idempotent replay)" : ""}: ${value.summary}` }],
        },
        async execute(args) {
            const input = args;
            return createReturnLabel(env, input);
        },
    }));
    ctx.tools.register(defineTool({
        name: "change_booking",
        description: "Change a booking's route in the mock service. The service enforces the written policy (no changes after departure). Pass a stable idempotency_key.",
        parameters: {
            booking_id: { type: "string", required: true, description: "Booking id." },
            new_route: { type: "string", required: true, description: "New route, e.g. SFO-EWR." },
            idempotency_key: { type: "string", required: true, description: "Stable unique key for this change." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    outcome: { type: "string", required: true },
                    receipt_sha256: { type: "string", required: true },
                    idempotent: { type: "boolean", required: true },
                    summary: { type: "string", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: `${value.outcome}${value.idempotent ? " (idempotent replay)" : ""}: ${value.summary}` }],
        },
        async execute(args) {
            const input = args;
            return changeBooking(env, input);
        },
    }));
    ctx.tools.register(defineTool({
        name: "refuse_request",
        description: "Record a policy refusal in the mock service's effect log without changing state. Pass a stable idempotency_key.",
        parameters: {
            kind: { type: "string", required: true, description: "Request kind, e.g. refund or booking_change." },
            target: { type: "string", required: true, description: "Target id, e.g. o-1001 or b-5001." },
            reason: { type: "string", required: true, description: "Policy reason for the refusal." },
            idempotency_key: { type: "string", required: true, description: "Stable unique key for this refusal." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    outcome: { type: "string", required: true },
                    receipt_sha256: { type: "string", required: true },
                    idempotent: { type: "boolean", required: true },
                    summary: { type: "string", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: `${value.outcome}${value.idempotent ? " (idempotent replay)" : ""}: ${value.summary}` }],
        },
        async execute(args) {
            const input = args;
            return refuseRequest(env, input);
        },
    }));
    ctx.tools.register(defineTool({
        name: "get_effect_status",
        description: "Query the mock service's append-only effect log for the latest outcome of an idempotency key. Use after an 'unknown' outcome before retrying.",
        parameters: {
            idempotency_key: { type: "string", required: true, description: "The key of the earlier effect." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    found: { type: "boolean", required: true },
                    outcome: { type: "json", required: true },
                    receipt_sha256: { type: "json", required: true },
                    summary: { type: "json", required: true },
                },
            },
            render: (_args, value) => [{ type: "text", text: value.found ? `${value.outcome}: ${value.summary}` : "No effect recorded for that key." }],
        },
        async execute(args) {
            const { idempotency_key } = args;
            return getEffectStatus(env, idempotency_key);
        },
    }));
}
//# sourceMappingURL=index.js.map