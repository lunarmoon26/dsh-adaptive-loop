import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { localWorkflowService } from "./client.js";
import { loadSnapshot, projectServiceState, ServiceJournalError, } from "./service.js";
const MAX_BODY_BYTES = 64 * 1024;
function record(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("request body must be a JSON object");
    }
    return value;
}
function text(input, key) {
    const value = input[key];
    if (typeof value !== "string" || value === "")
        throw new Error(`${key} must be a non-empty string`);
    return value;
}
function number(input, key) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${key} must be a finite number`);
    return value;
}
async function body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES)
            throw new Error("request body exceeds 64 KiB");
        chunks.push(bytes);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function json(response, status, value) {
    const payload = `${JSON.stringify(value)}\n`;
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
    });
    response.end(payload);
}
export function createWorkflowServiceServer(env, options) {
    if (options.evaluatorToken.length < 32)
        throw new Error("evaluator token must contain at least 32 characters");
    const service = localWorkflowService(env);
    return createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/health") {
                await loadSnapshot(env);
                json(response, 200, { status: "ready" });
                return;
            }
            if (request.method === "GET" && request.url === "/v1/evaluator/snapshot") {
                if (request.headers.authorization !== `Bearer ${options.evaluatorToken}`) {
                    json(response, 403, { error: "evaluator authorization failed" });
                    return;
                }
                const snapshot = await loadSnapshot(env);
                json(response, 200, {
                    state: projectServiceState(snapshot.state),
                    effects: snapshot.effects,
                    journal_sha256: snapshot.journal_sha256,
                });
                return;
            }
            if (request.method !== "POST" || request.url === undefined) {
                json(response, 404, { error: "unknown endpoint" });
                return;
            }
            const input = await body(request);
            switch (request.url) {
                case "/v1/get_order":
                    json(response, 200, { data: await service.getOrder(text(input, "order_id")) });
                    return;
                case "/v1/get_booking":
                    json(response, 200, { data: await service.getBooking(text(input, "booking_id")) });
                    return;
                case "/v1/issue_refund":
                    json(response, 200, await service.issueRefund({
                        order_id: text(input, "order_id"),
                        amount: number(input, "amount"),
                        reason: text(input, "reason"),
                        idempotency_key: text(input, "idempotency_key"),
                    }));
                    return;
                case "/v1/create_return_label":
                    json(response, 200, await service.createReturnLabel({
                        order_id: text(input, "order_id"),
                        idempotency_key: text(input, "idempotency_key"),
                    }));
                    return;
                case "/v1/change_booking":
                    json(response, 200, await service.changeBooking({
                        booking_id: text(input, "booking_id"),
                        new_route: text(input, "new_route"),
                        idempotency_key: text(input, "idempotency_key"),
                    }));
                    return;
                case "/v1/refuse_request":
                    json(response, 200, await service.refuseRequest({
                        kind: text(input, "kind"),
                        target: text(input, "target"),
                        reason: text(input, "reason"),
                        idempotency_key: text(input, "idempotency_key"),
                    }));
                    return;
                case "/v1/get_effect_status":
                    json(response, 200, await service.getEffectStatus(text(input, "idempotency_key")));
                    return;
                default:
                    json(response, 404, { error: "unknown endpoint" });
            }
        }
        catch (error) {
            const status = error instanceof ServiceJournalError && error.code === "SERVICE_IDEMPOTENCY_CONFLICT" ? 409 : 400;
            json(response, status, {
                error: error instanceof ServiceJournalError ? error.code : error instanceof Error ? error.message : "request failed",
            });
        }
    });
}
function parseProfile(raw, allowed) {
    if (raw === undefined || raw === "")
        return {};
    const parsed = record(JSON.parse(raw));
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (!allowed.includes(key) || !["success", "definite_failure", "unknown"].includes(String(value))) {
            throw new Error(`invalid service profile entry ${key}`);
        }
        result[key] = value;
    }
    return result;
}
async function main() {
    const stateRoot = process.env.DAL_SERVICE_STATE_ROOT;
    const evaluatorToken = process.env.DAL_EVALUATOR_TOKEN;
    if (stateRoot === undefined || evaluatorToken === undefined) {
        throw new Error("DAL_SERVICE_STATE_ROOT and DAL_EVALUATOR_TOKEN are required");
    }
    const kinds = ["issue_refund", "create_return_label", "change_booking", "refuse_request"];
    const faults = parseProfile(process.env.DAL_SERVICE_FAULTS, kinds);
    const rawResolutions = parseProfile(process.env.DAL_SERVICE_RESOLUTIONS, kinds);
    const resolutions = Object.fromEntries(Object.entries(rawResolutions).filter(([, outcome]) => outcome !== "unknown"));
    const server = createWorkflowServiceServer({
        stateRoot,
        faults,
        ...(resolutions === undefined ? {} : { resolutions }),
    }, { evaluatorToken });
    const port = Number.parseInt(process.env.DAL_SERVICE_PORT ?? "8787", 10);
    await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, "0.0.0.0", resolveListen);
    });
    process.stdout.write(`workflow service ready on ${port}\n`);
    const close = () => {
        server.close(() => process.exit(0));
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
//# sourceMappingURL=server.js.map