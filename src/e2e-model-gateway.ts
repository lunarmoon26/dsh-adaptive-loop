import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256 } from "./json.js";
import { reserveProposalBudget } from "./proposal-budget.js";

export interface E2eSpendPolicy {
  schema_version: "1.0.0";
  campaign_id: string;
  budget_id: string;
  approval_id: string;
  run_id: string;
  provider: "openai" | "anthropic";
  model: "gpt-5.6-terra" | "claude-sonnet-5";
  provider_limit_microusd: number;
  max_request_bytes: 65536;
  max_response_bytes: 2097152;
  timeout_ms: 120000;
  max_output_tokens: 1024;
  pricing_profile: "reviewed-text-upper-rates-20260907-v1";
  token_bound_profile: "json-bytes-times-two-plus-8192-v1";
  input_microusd_per_token: 5 | 4;
  output_microusd_per_token: 18 | 10;
}

export const GATEWAY_ROUTES = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
} as const;
const ajv = new Ajv2020({ strict: true });
const validatePolicy = ajv.compile(JSON.parse(await readFile(new URL("../schemas/e2e-spend-policy.v1.schema.json", import.meta.url), "utf8")));
const validateReservation = ajv.compile(JSON.parse(await readFile(new URL("../schemas/proposal-budget.v1.schema.json", import.meta.url), "utf8")));
const failureSchema = JSON.parse(await readFile(new URL("../schemas/gateway-failure.v1.schema.json", import.meta.url), "utf8"));
const validateFailure = ajv.compile(failureSchema);
export interface GatewayFailure {
  stage: "auth" | "request" | "admission" | "reservation" | "credential" | "upstream" | "response" | "persistence" | "cancel";
  code: string;
  reserved: boolean;
  upstream_status: number | null;
  provider_error_type: string | null;
  provider_error_code: string | null;
}
/** Exact closed validation; never return AJV errors containing untrusted values. */
export function validateGatewayFailure(value: unknown): asserts value is GatewayFailure {
  assert(validateFailure(value), "GATEWAY_FAILURE_INVALID");
}
class GatewayGuard extends Error {}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: ObjectValue, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function text(value: unknown): value is string { return typeof value === "string"; }
function assert(value: unknown, code = "GATEWAY_REJECTED"): asserts value { if (!value) throw new GatewayGuard(code); }

export function validateSpendPolicy(value: unknown): asserts value is E2eSpendPolicy {
  assert(validatePolicy(value));
}

/** This is an explicit experimental token upper-bound assumption, not measured billing. */
export function gatewayReservation(policy: E2eSpendPolicy, bodyBytes: number): number {
  assert(Number.isSafeInteger(bodyBytes) && bodyBytes > 0 && bodyBytes <= policy.max_request_bytes);
  return (2 * bodyBytes + 8192) * policy.input_microusd_per_token + policy.max_output_tokens * policy.output_microusd_per_token;
}

function admit(body: unknown, p: E2eSpendPolicy): asserts body is ObjectValue {
  assert(object(body) && body.model === p.model && (body.stream === undefined || typeof body.stream === "boolean"), "model_or_stream");
  const output = p.provider === "openai" ? body.max_output_tokens : body.max_tokens;
  assert(Number.isInteger(output) && Number(output) > 0 && Number(output) <= p.max_output_tokens, "output_limit");
  const content = (v: unknown, provider: string): boolean => text(v) || (Array.isArray(v) && v.every(c => {
    if (!object(c)) return false;
    if (provider === "openai") return keys(c, ["type", "text", "annotations"]) && ["input_text", "output_text"].includes(String(c.type)) && text(c.text) &&
      (c.annotations === undefined || (c.type === "output_text" && Array.isArray(c.annotations) && c.annotations.length === 0));
    if (c.type === "text") return keys(c, ["type", "text"]) && text(c.text);
    if (c.type === "tool_use") return keys(c, ["type", "id", "name", "input"]) && text(c.id) && text(c.name) && object(c.input);
    return c.type === "tool_result" && keys(c, ["type", "tool_use_id", "content", "is_error"]) && text(c.tool_use_id) &&
      (c.is_error === undefined || typeof c.is_error === "boolean") && (text(c.content) || (Array.isArray(c.content) && c.content.every(t => object(t) && keys(t, ["type", "text"]) && t.type === "text" && text(t.text))));
  }));
  if (p.provider === "openai") {
    assert(keys(body, ["model", "input", "instructions", "max_output_tokens", "stream", "tools", "tool_choice", "parallel_tool_calls", "store", "temperature", "top_p", "reasoning", "prompt_cache_options", "text"]), "unknown_fields");
    assert(body.reasoning === undefined || (object(body.reasoning) && keys(body.reasoning, ["effort"]) && body.reasoning.effort === "none"), "reasoning_denied");
    if (Array.isArray(body.input)) for (const item of body.input) {
      assert(!object(item) || (item.type !== "reasoning" && item.encrypted_content === undefined), "reasoning_denied");
      assert(!object(item) || item.type !== "item_reference", "reference_denied");
    }
    assert(body.prompt_cache_options === undefined || (object(body.prompt_cache_options) && keys(body.prompt_cache_options, ["mode"]) && body.prompt_cache_options.mode === "explicit"), "cache_options");
    assert(body.text === undefined || (object(body.text) && keys(body.text, ["format"]) && object(body.text.format) && keys(body.text.format, ["type"]) && body.text.format.type === "json_object"), "text_format");
    assert(body.store === false, "store_denied"); // Do not create server-side context for subsequent requests.
    assert(body.instructions === undefined || text(body.instructions), "instructions_shape");
    assert(text(body.input) || (Array.isArray(body.input) && body.input.every(item => {
      if (!object(item)) return false;
      // IDs annotate complete inline replay items; they never replace charged content.
      if (item.type === "function_call") return keys(item, ["type", "id", "call_id", "name", "arguments"]) &&
        (item.id === undefined || (text(item.id) && /^fc_[a-zA-Z0-9_-]{1,61}$/.test(item.id))) && text(item.call_id) && text(item.name) && text(item.arguments);
      if (item.type === "function_call_output") return keys(item, ["type", "call_id", "output"]) && text(item.call_id) && text(item.output);
      return keys(item, ["type", "role", "content", "id", "status", "phase"]) && (item.type === undefined || item.type === "message") &&
        (item.id === undefined || (item.role === "assistant" && text(item.id) && /^msg_[a-zA-Z0-9_-]{1,60}$/.test(item.id))) &&
        (item.status === undefined || (item.role === "assistant" && item.status === "completed")) &&
        (item.phase === undefined || (item.role === "assistant" && ["commentary", "final_answer"].includes(String(item.phase)))) &&
        ["user", "assistant", "system", "developer"].includes(String(item.role)) && content(item.content, "openai");
    })), "GATEWAY_OPENAI_INPUT");
  } else {
    assert(keys(body, ["model", "messages", "system", "max_tokens", "stream", "tools", "tool_choice", "temperature", "top_p", "stop_sequences"]), "unknown_fields");
    assert(body.system === undefined || text(body.system) || (Array.isArray(body.system) && body.system.every(c => object(c) && keys(c, ["type", "text"]) && c.type === "text" && text(c.text))), "system_shape");
    assert(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.every(m => object(m) && keys(m, ["role", "content"]) && ["user", "assistant"].includes(String(m.role)) && content(m.content, "anthropic")), "messages_shape");
    assert(body.stop_sequences === undefined || (Array.isArray(body.stop_sequences) && body.stop_sequences.every(text)), "stop_sequences");
  }
  assert(body.tools === undefined || (Array.isArray(body.tools) && body.tools.every(t => {
    if (!object(t) || !text(t.name) || (t.description !== undefined && !text(t.description))) return false;
    if (p.provider === "openai") return keys(t, ["type", "name", "description", "parameters", "strict"]) && t.type === "function" && object(t.parameters) && (t.strict === undefined || typeof t.strict === "boolean");
    return keys(t, ["name", "description", "input_schema", "eager_input_streaming", "strict"]) && object(t.input_schema) &&
      (t.eager_input_streaming === undefined || t.eager_input_streaming === true) && (t.strict === undefined || t.strict === true);
  })), "GATEWAY_TOOLS");
  if (body.tool_choice !== undefined) {
    const c = body.tool_choice;
    assert(p.provider === "openai" ? (["auto", "none", "required"].includes(String(c)) || (object(c) && keys(c, ["type", "name"]) && c.type === "function" && text(c.name))) :
      (object(c) && keys(c, ["type", "name", "disable_parallel_tool_use"]) && ["auto", "any", "none", "tool"].includes(String(c.type)) &&
        (c.type !== "tool" || text(c.name)) && (c.disable_parallel_tool_use === undefined || typeof c.disable_parallel_tool_use === "boolean")), "tool_choice");
  }
  assert(body.parallel_tool_calls === undefined || typeof body.parallel_tool_calls === "boolean", "parallel_tool_calls");
  for (const key of ["temperature", "top_p"]) assert(body[key] === undefined || (typeof body[key] === "number" && Number.isFinite(body[key]) && Number(body[key]) >= 0 && Number(body[key]) <= (key === "temperature" ? 2 : 1)), "sampling_range");
  // Reject remote schema references, even nested inside custom tool schemas.
  const walk = (v: unknown, depth = 0): void => {
    assert(depth <= 64, "nesting_limit");
    if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (object(v)) for (const [k, x] of Object.entries(v)) {
      assert(!["$ref", "$dynamicRef", "$recursiveRef"].includes(k) || (text(x) && x.startsWith("#")), "reference_denied");
      walk(x, depth + 1);
    }
  };
  walk(body);
}

/** Trusted test seam only. Never supplied by HTTP, environment, or candidate configuration. */
export type GatewayUpstream = (url: string, init: RequestInit) => Promise<Response>;

/** Minimal protocol fixture, not evidence of workflow success. No sockets or credentials. */
export function createRehearsalUpstream(): GatewayUpstream {
  let sequence = 0;
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as ObjectValue;
    const first = sequence++ === 0;
    const anthropic = url === GATEWAY_ROUTES.anthropic;
    // Proposer-only offline fixture. The asserted base is deliberately unverified.
    const messages = anthropic ? body.messages : body.input;
    const prompt = Array.isArray(messages) ? messages.find(m => object(m) && m.role === "user") : undefined;
    if (body.stream === false && body.tools === undefined && object(prompt) && text(prompt.content)) {
      let payload: unknown;
      try { payload = JSON.parse(prompt.content); } catch { /* Not a proposer prompt. */ }
      if (object(payload) && payload.task === "propose_one_falsifiable_change" && text(payload.output_contract)) {
        const proposal = JSON.stringify({
          surface: "skills", target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
          base_sha256: "9".repeat(64), title: "Rehearsal proposal: require return labels",
          objective: "Create a return label before issuing a full refund.",
          statement: "Applying this change raises task_success_rate by at least 0.2 without regressing golden cases.",
          improvements: [{ metric: "task_success_rate", expected_delta: 0.2 }], regressions: [],
        });
        return Response.json(anthropic ? {
          type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
          content: [{ type: "text", text: proposal }],
        } : {
          status: "completed", model: body.model,
          output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: proposal }] }],
        });
      }
    }
    const tool = anthropic ? { type: "tool_use", id: "call_rehearsal", name: "get_order", input: { order_id: "o-1001" } } :
      { type: "function_call", id: "fc_rehearsal", call_id: "call_rehearsal", name: "get_order", arguments: '{"order_id":"o-1001"}', status: "completed" };
    const answer = anthropic ? { type: "text", text: "DONE" } : { type: "message", id: "msg_rehearsal", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] };
    const item = first ? tool : answer;
    // Regression fixture for the paid run: empty-visible encrypted reasoning
    // is returned even though the route is configured for a text-only budget.
    const reasoningItem = { id: "rs_rehearsal", type: "reasoning", content: [], summary: [], encrypted_content: "rehearsal-opaque-placeholder" };
    const toolIndex = first ? 1 : 0;
    const response = anthropic ? { id: "msg_rehearsal", type: "message", role: "assistant", model: body.model, content: [item], stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } :
      { id: "resp_rehearsal", object: "response", status: "completed", model: body.model, output: first ? [reasoningItem, item] : [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    if (!body.stream) return Response.json(response);
    const events: ObjectValue[] = anthropic ? [
      { type: "message_start", message: { ...response, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: first ? { ...tool, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: first ? { type: "input_json_delta", partial_json: '{"order_id":"o-1001"}' } : { type: "text_delta", text: "DONE" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ] : [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ...(first ? [
        { type: "response.output_item.added", output_index: 0, item: reasoningItem },
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      ] : []),
      { type: "response.output_item.added", output_index: toolIndex, item: first ? { ...tool, arguments: "", status: "in_progress" } : { ...answer, content: [], status: "in_progress" } },
      ...(first ? [
        { type: "response.function_call_arguments.delta", item_id: "fc_rehearsal", output_index: toolIndex, delta: '{"order_id":"o-1001"}' },
        { type: "response.function_call_arguments.done", item_id: "fc_rehearsal", output_index: toolIndex, arguments: '{"order_id":"o-1001"}' },
      ] : [
        { type: "response.content_part.added", item_id: "msg_rehearsal", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: "msg_rehearsal", output_index: 0, content_index: 0, delta: "DONE" },
        { type: "response.output_text.done", item_id: "msg_rehearsal", output_index: 0, content_index: 0, text: "DONE" },
        { type: "response.content_part.done", item_id: "msg_rehearsal", output_index: 0, content_index: 0, part: { type: "output_text", text: "DONE", annotations: [] } },
      ]),
      { type: "response.output_item.done", output_index: toolIndex, item },
      { type: "response.completed", response },
    ];
    return new Response(events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify(anthropic ? e : { ...e, sequence_number: i })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
}

// Read the same canonical hash chain as the reservation writer, without mutating it.
async function ledgerReceipt(root: string, p: E2eSpendPolicy): Promise<{ reservations: number; reserved_microusd: number }> {
  const directory = join(root, p.budget_id, p.provider);
  try { await lstat(`${directory}.lock`); throw new Error("GATEWAY_LEDGER_BUSY"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const checkDirectory = async (path: string): Promise<void> => {
    if (dirname(path) !== path) await checkDirectory(dirname(path));
    assert((await lstat(path)).isDirectory());
  };
  const read = async (path: string): Promise<ObjectValue> => {
    const stat = await lstat(path);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= 4096);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      assert(stat.ino === opened.ino && stat.dev === opened.dev);
      const raw = await handle.readFile("utf8");
      const value: unknown = JSON.parse(raw);
      assert(validateReservation(value) && object(value) && raw === `${canonicalJson(value)}\n`);
      return value;
    } finally { await handle.close(); }
  };
  // A missing, uninitialized ledger is zero. Missing entries within an existing ledger are corruption.
  for (const path of [root, join(root, p.budget_id), directory]) {
    try { await checkDirectory(path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { reservations: 0, reserved_microusd: 0 };
      throw e;
    }
  }
  assert((await readdir(directory)).sort().join(",") === "cap.json,reservations");
  await checkDirectory(join(directory, "reservations"));
  const cap = await read(join(directory, "cap.json"));
  assert(cap.kind === "cap" && cap.budget_id === p.budget_id && cap.provider === p.provider && cap.provider_limit_microusd === p.provider_limit_microusd);
  let previous = sha256(canonicalJson(cap));
  let total = 0;
  const seen = new Set<string>();
  const names = (await readdir(join(directory, "reservations"))).sort();
  for (const [i, name] of names.entries()) {
    assert(/^\d{16}-[a-f0-9]{64}\.json$/.test(name));
    const record = await read(join(directory, "reservations", name));
    const digest = sha256(canonicalJson(record));
    assert(record.kind === "reservation" && record.budget_id === p.budget_id && record.provider === p.provider && record.provider_limit_microusd === p.provider_limit_microusd && record.sequence === i + 1 && record.previous_sha256 === previous && name === `${String(i + 1).padStart(16, "0")}-${digest}.json` && !seen.has(String(record.request_digest)));
    const amount = Number(record.reservation_microusd);
    assert(amount <= p.provider_limit_microusd - total);
    total += amount;
    seen.add(String(record.request_digest));
    previous = digest;
  }
  return { reservations: names.length, reserved_microusd: total };
}

export async function startGateway(options: {
  policy: E2eSpendPolicy;
  ledgerRoot: string;
  token: string;
  mode: "live" | "rehearsal";
  upstream?: GatewayUpstream;
  host?: string;
  port?: number;
}): Promise<{ address: string; close: () => Promise<void> }> {
  const policy: E2eSpendPolicy = structuredClone(options.policy);
  validateSpendPolicy(policy);
  assert(isAbsolute(options.ledgerRoot) && resolve(options.ledgerRoot) === options.ledgerRoot);
  assert(typeof options.token === "string" && options.token.length >= 32 && !/\s/.test(options.token));
  assert(options.mode === "live" || options.mode === "rehearsal");
  assert(options.mode !== "rehearsal" || options.upstream === undefined);
  const tokenHash = createHash("sha256").update(options.token).digest();
  const fixture = createRehearsalUpstream();
  const transport = options.mode === "rehearsal" ? fixture : options.upstream ?? fetch;
  const counts = { completed: 0, failed: 0, rejected: 0, response_bytes: 0 };
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let unhealthy = false;
  const diagnosticDirectory = join(options.ledgerRoot, "gateway-failures", sha256(canonicalJson({ budget: policy.budget_id, campaign: policy.campaign_id, run: policy.run_id, provider: policy.provider })));
  const ensureDirectory = async (path: string): Promise<void> => {
    if (dirname(path) !== path) await ensureDirectory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    assert((await lstat(path)).isDirectory());
  };
  await ensureDirectory(diagnosticDirectory);
  let droppedCount = 0;
  let persistenceFailure = false;
  let diagnosticQueue = Promise.resolve();
  let queuedDiagnostics = 0;
  const diagnostics = async (): Promise<{ records: GatewayFailure[]; dropped_count: number }> => {
    const records: GatewayFailure[] = [];
    for (let i = 0; i <= 32; i++) {
      let handle;
      try { handle = await open(join(diagnosticDirectory, `${i}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.size <= 1024);
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (i === 32) { assert(value === 1); droppedCount = Math.max(1, droppedCount); }
        else { validateGatewayFailure(value); records.push(value); }
      } finally { await handle.close(); }
    }
    if (persistenceFailure) {
      if (records.length === 32) records.pop();
      records.push({ stage: "persistence", code: "persistence_failed", reserved: false, upstream_status: null, provider_error_type: null, provider_error_code: null });
    }
    return { records, dropped_count: droppedCount };
  };
  await diagnostics();
  const recordFailure = (failure: GatewayFailure): Promise<void> => {
    validateGatewayFailure(failure);
    if (queuedDiagnostics >= 33) {
      droppedCount = Math.min(Number.MAX_SAFE_INTEGER, droppedCount + 1);
      return diagnosticQueue;
    }
    queuedDiagnostics++;
    diagnosticQueue = diagnosticQueue.then(async () => {
      for (let i = 0; i <= 32; i++) {
        if (i === 32) droppedCount = Math.min(Number.MAX_SAFE_INTEGER, droppedCount + 1);
        let handle;
        try { handle = await open(join(diagnosticDirectory, `${i}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
        try { await handle.writeFile(`${canonicalJson(i === 32 ? 1 : failure)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        for (const path of [diagnosticDirectory, dirname(diagnosticDirectory), options.ledgerRoot]) {
          const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        }
        break;
      }
    }).catch(() => { unhealthy = true; persistenceFailure = true; }).finally(() => { queuedDiagnostics--; });
    return diagnosticQueue;
  };
  const server = createServer(async (req, res) => {
    let finish!: () => void;
    const settled = new Promise<void>(done => { finish = done; });
    pending.add(settled);
    const abort = new AbortController();
    controllers.add(abort);
    let cancelCode = "shutdown";
    const timer = setTimeout(() => { cancelCode = "timeout"; abort.abort(); }, policy.timeout_ms);
    const onClose = (): void => { if (!res.writableFinished) { cancelCode = "disconnect"; abort.abort(); } };
    res.on("close", onClose);
    req.on("aborted", () => { cancelCode = "disconnect"; abort.abort(); });
    const failure: GatewayFailure = { stage: "auth", code: "auth_denied", reserved: false, upstream_status: null, provider_error_type: null, provider_error_code: null };
    const phase = (stage: GatewayFailure["stage"], code: string): void => { failure.stage = stage; failure.code = code; };
    let reserved = false;
    let requestDigest: string | undefined;
    let completed = false;
    let responseBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const fail = (status: number): void => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":"gateway_request_failed"}'); }
    };
    const aborted = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => {
      if (!req.complete) req.destroy();
      reject(new Error("GATEWAY_ABORTED"));
    }, { once: true }));
    // Attach immediately, including while reading the client body.
    void aborted.catch(() => undefined);
    try {
      if (req.method === "GET" && req.url === "/health") {
        phase("persistence", "persistence_failed"); assert(!unhealthy);
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"ready":true}'); return;
      }
      const auth = req.headers.authorization ?? (typeof req.headers["x-api-key"] === "string" ? `Bearer ${req.headers["x-api-key"]}` : "");
      assert(auth.startsWith("Bearer ") && timingSafeEqual(tokenHash, createHash("sha256").update(auth.slice(7)).digest()));
      if (req.method === "GET" && req.url === "/receipt") {
        phase("persistence", "persistence_failed");
        await diagnosticQueue;
        const ledger = await ledgerReceipt(options.ledgerRoot, policy);
        const failure_diagnostics = await diagnostics();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ campaign_id: policy.campaign_id, run_id: policy.run_id, provider: policy.provider, mode: options.mode, ...ledger, process_counts: counts, failure_diagnostics, accounting: "upper-bound-reservations-no-refund" }));
        return;
      }
      phase("persistence", "persistence_failed"); assert(!unhealthy);
      phase("request", "route_denied");
      assert(req.method === "POST" && req.url === new URL(GATEWAY_ROUTES[policy.provider]).pathname);
      phase("request", "request_content_type");
      assert(req.headers["content-encoding"] === undefined && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? ""));
      const chunks: Buffer[] = [];
      let bytes = 0;
      phase("request", "request_oversize");
      for await (const chunk of req) {
        bytes += chunk.length;
        assert(bytes <= policy.max_request_bytes);
        chunks.push(Buffer.from(chunk));
      }
      assert(!abort.signal.aborted);
      const raw = Buffer.concat(chunks);
      phase("request", "request_json");
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      phase("admission", "admission_denied");
      admit(body, policy);
      // Numeric JSON spellings can expand when the provider renders a tool schema.
      const chargedBytes = Math.max(bytes, Buffer.byteLength(canonicalJson(body)));
      assert(chargedBytes <= policy.max_request_bytes, "request_oversize");
      // Canonical body prevents whitespace/key-order-only retries. Run and campaign are launcher-owned.
      requestDigest = sha256(canonicalJson({ campaign_id: policy.campaign_id, run_id: policy.run_id, provider: policy.provider, body }));
      phase("reservation", "reservation_failed");
      assert(gatewayReservation(policy, chargedBytes) <= policy.provider_limit_microusd, "budget_exhausted");
      await reserveProposalBudget({ store: options.ledgerRoot, budget: { budget_id: policy.budget_id, provider_limit_microusd: policy.provider_limit_microusd, reservation_microusd: gatewayReservation(policy, chargedBytes) }, provider: policy.provider, requestDigest, approvalId: policy.approval_id });
      reserved = true;
      failure.reserved = true;
      assert(!abort.signal.aborted);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (policy.provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
      if (options.mode === "live" && !options.upstream) {
        phase("credential", "credential_missing");
        // Read only this provider's designated key, only after durable reservation.
        const key = process.env[policy.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
        assert(key);
        phase("credential", "credential_invalid"); assert(!/[\r\n]/.test(key));
        headers[policy.provider === "openai" ? "authorization" : "x-api-key"] = policy.provider === "openai" ? `Bearer ${key}` : key;
      }
      phase("upstream", "network_exception");
      const upstream = await Promise.race([transport(GATEWAY_ROUTES[policy.provider], { method: "POST", headers, body: raw.toString("utf8"), redirect: "error", signal: abort.signal }), aborted]);
      failure.upstream_status = Number.isInteger(upstream.status) && upstream.status >= 100 && upstream.status <= 599 ? upstream.status : null;
      if (!upstream.ok) {
        phase("upstream", "http_rejected");
        if (upstream.body) {
          reader = upstream.body.getReader();
          const parts: Buffer[] = []; let size = 0;
          try {
            for (;;) {
              const { done, value } = await Promise.race([reader.read(), aborted]);
              if (done) break;
              size += value.byteLength;
              if (size > 8192) break;
              parts.push(Buffer.from(value));
              if (size === 8192) break;
            }
            if (size <= 8192) {
              const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
              if (object(parsed) && object(parsed.error)) for (const field of ["type", "code"] as const) {
                const value = parsed.error[field];
                const target = field === "type" ? "provider_error_type" : "provider_error_code";
                if (typeof value === "string" && failureSchema.properties[target].enum.includes(value)) failure[target] = value;
              }
            }
          } catch { /* Provider bodies and exceptions are never diagnostic strings. */ }
        }
        assert(false);
      }
      phase("response", "response_body_missing"); assert(upstream.body);
      const mime = upstream.headers.get("content-type")?.split(";")[0]?.trim();
      phase("response", "response_content_type");
      assert(mime === (body.stream ? "text/event-stream" : "application/json"));
      reader = upstream.body.getReader();
      const responseChunks: Buffer[] = [];
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store", "x-accel-buffering": "no" });
      for (;;) {
        phase("upstream", "network_exception");
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        responseBytes += value.byteLength;
        phase("response", "response_oversize"); assert(responseBytes <= policy.max_response_bytes);
        responseChunks.push(Buffer.from(value));
        counts.response_bytes = Math.min(Number.MAX_SAFE_INTEGER, counts.response_bytes + value.byteLength);
        if (!res.write(value)) await Promise.race([new Promise<void>(resolveDrain => res.once("drain", resolveDrain)), aborted]);
      }
      // Bounded, ephemeral parsing only: never store raw provider data or usage as billing.
      const responseText = Buffer.concat(responseChunks).toString("utf8");
      if (body.stream) {
        const events = responseText.split(/\r?\n\r?\n/).flatMap(frame => {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") return [];
          try { return [JSON.parse(data) as ObjectValue]; } catch { return []; }
        });
        phase("response", "sse_error");
        assert(!events.some(e => ["error", "response.failed", "response.incomplete"].includes(String(e.type))));
        phase("response", "sse_missing_terminal");
        assert(events.some(e => policy.provider === "anthropic" ? e.type === "message_stop" : e.type === "response.completed" && object(e.response) && e.response.status === "completed"));
        if (policy.provider === "anthropic") assert(events.some(e => e.type === "message_delta" && object(e.delta) && ["end_turn", "tool_use", "stop_sequence"].includes(String(e.delta.stop_reason))));
      } else {
        phase("response", "response_json");
        const parsed: unknown = JSON.parse(responseText);
        phase("response", "response_incomplete");
        assert(object(parsed) && (policy.provider === "openai" ? parsed.status === "completed" : parsed.type === "message" && ["end_turn", "tool_use", "stop_sequence"].includes(String(parsed.stop_reason))));
      }
      res.end();
      completed = true;
      counts.completed = Math.min(Number.MAX_SAFE_INTEGER, counts.completed + 1);
    } catch (error) {
      if (abort.signal.aborted) phase("cancel", cancelCode);
      else if (failure.stage === "admission" && error instanceof GatewayGuard) {
        const code = error.message === "GATEWAY_OPENAI_INPUT" ? "openai_input" : error.message === "GATEWAY_TOOLS" ? "tools_denied" : error.message;
        if (failureSchema.properties.code.enum.includes(code)) failure.code = code;
      } else if (failure.stage === "reservation") {
        const code = (error as { code?: unknown })?.code;
        if (code === "PROPOSE_REQUEST_ALREADY_RESERVED") failure.code = "replay_rejected";
        if (code === "PROPOSE_BUDGET_EXCEEDED") failure.code = "budget_exhausted";
        if (error instanceof GatewayGuard && error.message === "budget_exhausted") failure.code = "budget_exhausted";
      }
      if (reserved) counts.failed = Math.min(Number.MAX_SAFE_INTEGER, counts.failed + 1);
      else counts.rejected = Math.min(Number.MAX_SAFE_INTEGER, counts.rejected + 1);
      await recordFailure(failure);
      fail(reserved ? 502 : 400);
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (reader) void reader.cancel().catch(() => undefined);
      if (reserved && requestDigest) {
        // Separate from the shared ledger's strict directory layout. Missing summaries
        // after a crash mean unknown outcome, never permission to refund or replay.
        try {
          const directory = join(options.ledgerRoot, "gateway-outcomes");
          try { await mkdir(directory, { mode: 0o700 }); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
          assert((await lstat(directory)).isDirectory());
          const handle = await open(join(directory, `${sha256(`${policy.budget_id}:${policy.provider}:${requestDigest}`)}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            await handle.writeFile(`${canonicalJson({ schema_version: "1.0.0", campaign_id: policy.campaign_id, run_id: policy.run_id, provider: policy.provider, request_digest: requestDigest, mode: options.mode, outcome: completed ? "completed" : "failed_or_partial", response_bytes: Math.min(responseBytes, policy.max_response_bytes), accounting: "upper-bound-reservations-no-refund" })}\n`);
            await handle.sync();
          } finally { await handle.close(); }
          for (const path of [directory, options.ledgerRoot]) {
            const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { await parent.sync(); } finally { await parent.close(); }
          }
        } catch {
          // Fail future admission instead of hiding an evidence persistence failure.
          unhealthy = true;
          await recordFailure({ stage: "persistence", code: "persistence_failed", reserved, upstream_status: failure.upstream_status, provider_error_type: null, provider_error_code: null });
        }
      }
      controllers.delete(abort);
      res.off("close", onClose);
      pending.delete(settled);
      finish();
    }
  });
  server.requestTimeout = policy.timeout_ms;
  server.headersTimeout = Math.min(30000, policy.timeout_ms);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { address: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`, close: async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await Promise.all(pending);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const policyPath = process.env.DAL_GATEWAY_POLICY;
    assert(policyPath && !/(^|\/)\.env(?:\.|$)/.test(policyPath));
    const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
    validateSpendPolicy(policy);
    const mode = process.env.DAL_GATEWAY_MODE;
    assert(mode === "live" || mode === "rehearsal");
    const gateway = await startGateway({ policy, ledgerRoot: process.env.DAL_GATEWAY_LEDGER_ROOT ?? "/gateway-ledger", token: process.env.DAL_GATEWAY_TOKEN ?? "", mode, host: "0.0.0.0", port: 8787 });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void gateway.close(); });
  } catch { process.stderr.write("Gateway startup failed\n"); process.exitCode = 1; }
}
