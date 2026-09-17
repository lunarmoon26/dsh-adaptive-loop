import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyApprovalFile } from "../approval.js";
import { DalError } from "../errors.js";
import { assertIJsonText, canonicalJson, prettyJson, publishJsonExclusive, sha256 } from "../json.js";
import { assertNoSymlinkTraversal, prepareSafeRepositoryDirectory } from "../repository.js";
import { assertSchema, SCHEMA_IDS } from "../schema.js";
import { liveAssert, liveRoot, nativeMountScope, planDigest, readLive, scanLive, validateLivePlan, verifyLiveGrant } from "./authority.js";
import { nativeRuntimeIdentity, nativeTextDriver } from "./native.js";
import type { Evaluation, Generation, LiveCase, LiveOperation, LivePlan, LiveState, TextDriver, TextRequest } from "./types.js";

export interface LiveOptions {
  campaign: string;
  grant: string;
  mountApproval: string;
}
export interface LiveDependencies {
  driver: TextDriver;
  runtimeIdentity(): Promise<string>;
}
const native: LiveDependencies = { driver: nativeTextDriver, runtimeIdentity: nativeRuntimeIdentity };
const digest = (value: unknown) => sha256(canonicalJson(value));
const snapshotName = (sequence: number) => `state-${String(sequence).padStart(4, "0")}.json`;

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function immutable(path: string, value: unknown): Promise<void> {
  await assertNoSymlinkTraversal(path);
  scanLive(value);
  if (!await publishJsonExclusive(path, value)) liveAssert(digest(await readLive(path)) === digest(value), "LIVE_RECORD_CONFLICT");
}
async function atomic(path: string, value: unknown): Promise<void> {
  await assertNoSymlinkTraversal(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(prettyJson(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}
async function loadPlan(id: string): Promise<LivePlan> {
  const root = liveRoot(id);
  await assertNoSymlinkTraversal(root);
  const plan = await validateLivePlan(await readLive(join(root, "plan.json")));
  liveAssert(plan.campaign_id === id, "LIVE_PLAN_MISMATCH");
  return plan;
}
async function generation(plan: LivePlan, id: string): Promise<Generation> {
  liveAssert(/^[a-f0-9]{64}$/.test(id), "LIVE_INVALID_GENERATION");
  const value = await readLive<Generation>(join(liveRoot(plan.campaign_id), "generations", `${id}.json`));
  await assertSchema(SCHEMA_IDS.liveGeneration, value, "Live generation");
  liveAssert(value.id === id && sha256(value.prompt) === id && Buffer.byteLength(value.prompt) <= plan.limits.prompt_bytes, "LIVE_GENERATION_DRIFT");
  return value;
}
async function saveGeneration(plan: LivePlan, prompt: string, hypothesis: Generation["hypothesis"]): Promise<Generation> {
  const value: Generation = { id: sha256(prompt), prompt, hypothesis };
  scanLive(value);
  await assertSchema(SCHEMA_IDS.liveGeneration, value, "Live generation");
  liveAssert(Buffer.byteLength(prompt) <= plan.limits.prompt_bytes, "LIVE_PROMPT_LIMIT");
  const path = join(liveRoot(plan.campaign_id), "generations", `${value.id}.json`);
  if (await exists(path)) return generation(plan, value.id);
  await immutable(path, value);
  return value;
}
async function saveState(plan: LivePlan, previous: LiveState | null, delta: Partial<LiveState>): Promise<LiveState> {
  const baseline = sha256(plan.base_prompt);
  const value: LiveState = {
    $schema: SCHEMA_IDS.liveState, schema_version: "1.0.0", sequence: 0, previous_sha256: null,
    plan_sha256: planDigest(plan), phase: "prepared", active: baseline, retained: [baseline],
    evaluations: [], candidate_index: 0, last_error: null,
    ...previous, ...delta, ...(previous === null ? {} : { sequence: previous.sequence + 1, previous_sha256: digest(previous) }),
  };
  await assertSchema(SCHEMA_IDS.liveState, value, "Live state");
  const root = liveRoot(plan.campaign_id);
  await immutable(join(root, snapshotName(value.sequence)), value);
  await atomic(join(root, "current.json"), { sequence: value.sequence, state_sha256: digest(value), generation: value.active });
  return value;
}
async function loadState(plan: LivePlan): Promise<LiveState> {
  const root = liveRoot(plan.campaign_id);
  const names = (await readdir(root)).filter((name) => /^state-/.test(name) && name.endsWith(".json")).sort();
  liveAssert(names.length > 0 && names.length <= 1001, "LIVE_HISTORY_INVALID");
  let last: LiveState | null = null;
  for (const [index, name] of names.entries()) {
    liveAssert(name === snapshotName(index), "LIVE_HISTORY_INVALID");
    const value = await readLive<LiveState>(join(root, name));
    await assertSchema(SCHEMA_IDS.liveState, value, "Live state");
    liveAssert(value.sequence === index && value.plan_sha256 === planDigest(plan) && value.previous_sha256 === (last === null ? null : digest(last)), "LIVE_HISTORY_DRIFT");
    liveAssert(value.candidate_index <= plan.limits.candidates && value.retained[0] === sha256(plan.base_prompt), "LIVE_HISTORY_DRIFT");
    for (const id of new Set([value.active, ...value.retained])) await generation(plan, id);
    if (index === 0) liveAssert(value.phase === "prepared" && value.active === sha256(plan.base_prompt) && value.evaluations.length === 0, "LIVE_HISTORY_DRIFT");
    if (last) liveAssert(value.candidate_index >= last.candidate_index, "LIVE_HISTORY_DRIFT");
    for (const [evaluationIndex, evaluation] of value.evaluations.entries()) {
      const gen = await generation(plan, evaluation.generation);
      const prefix = evaluationIndex === 0 ? "baseline" : `candidate-${evaluationIndex - 1}`;
      const cases: Evaluation["cases"] = [];
      for (const item of plan.cases.filter((item) => item.role !== "canary")) {
        const operation = `${prefix}-${item.id}`;
        const receipt = await readLive<LiveOperation>(join(root, "operations", `${operation}.receipt.json`));
        await assertSchema(SCHEMA_IDS.liveOperation, receipt, "Live receipt");
        liveAssert(receipt.operation === operation && receipt.plan_sha256 === planDigest(plan) && receipt.generation === gen.id && receipt.phase === "task" && receipt.status === "succeeded"
          && receipt.request_sha256 === digest(requestFor(plan, taskSystem(plan, gen), item.input))
          && receipt.response !== null && receipt.response_sha256 === digest(receipt.response), "LIVE_RECEIPT_DRIFT");
        const intent = await readLive<LiveOperation>(join(root, "operations", `${operation}.intent.json`));
        await assertSchema(SCHEMA_IDS.liveOperation, intent, "Live reservation");
        liveAssert(intent.status === "reserved" && intent.request_sha256 === receipt.request_sha256 && intent.plan_sha256 === receipt.plan_sha256 && intent.operation === operation && intent.generation === gen.id, "LIVE_RECEIPT_DRIFT");
        cases.push({ id: item.id, pass: canonicalJson(receipt.response) === canonicalJson(item.expected), response_sha256: receipt.response_sha256! });
      }
      const mean = (role: LiveCase["role"]) => {
        const values = cases.filter((entry) => plan.cases.find((item) => item.id === entry.id)!.role === role);
        return values.filter((entry) => entry.pass).length / values.length;
      };
      liveAssert(canonicalJson(evaluation) === canonicalJson({ generation: gen.id, development: mean("development"), qualification: mean("qualification"), cases }), "LIVE_SCORE_DRIFT");
    }
    if (value.active !== sha256(plan.base_prompt)) liveAssert(value.active === selected(plan, value), "LIVE_SELECTION_DRIFT");
    last = value;
  }
  return last!;
}
async function activeGeneration(plan: LivePlan, state: LiveState): Promise<Generation> {
  const pointer = await readLive<{ sequence: number; state_sha256: string; generation: string }>(join(liveRoot(plan.campaign_id), "current.json"));
  await assertSchema(SCHEMA_IDS.livePointer, pointer, "Live active pointer");
  liveAssert(canonicalJson(pointer) === canonicalJson({ sequence: state.sequence, state_sha256: digest(state), generation: state.active }), "LIVE_POINTER_DRIFT");
  return generation(plan, pointer.generation);
}
async function withLease<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const path = join(liveRoot(id), "lease.json");
  await assertNoSymlinkTraversal(path);
  let handle;
  try { handle = await open(path, "wx", 0o600); } catch { throw new DalError("LIVE_BUSY", "Campaign is owned by another process; recover only after its owner has stopped"); }
  try {
    await handle.writeFile(prettyJson({ pid: process.pid })); await handle.sync();
    return await fn();
  } finally { await handle.close(); await unlink(path); }
}

export async function prepareLive(planPath: string, dependencies = native): Promise<{ plan_sha256: string; mount_scope: string; state: LiveState }> {
  const plan = await validateLivePlan(await readLive(planPath));
  liveAssert(plan.runtime_sha256 === await dependencies.runtimeIdentity(), "LIVE_RUNTIME_DRIFT");
  const root = liveRoot(plan.campaign_id);
  await prepareSafeRepositoryDirectory(root);
  return withLease(plan.campaign_id, async () => {
    await immutable(join(root, "plan.json"), plan);
    await saveGeneration(plan, plan.base_prompt, null);
    let state;
    if (await exists(join(root, snapshotName(0)))) state = await loadState(plan);
    else state = await saveState(plan, null, {});
    return { plan_sha256: planDigest(plan), mount_scope: nativeMountScope(plan), state };
  });
}

async function authorize(plan: LivePlan, options: LiveOptions, dependencies: LiveDependencies, action: "send_text" | "activate_prompt" | "rollback_prompt"): Promise<void> {
  await verifyLiveGrant(plan, options.grant, action);
  liveAssert(plan.runtime_sha256 === await dependencies.runtimeIdentity(), "LIVE_RUNTIME_DRIFT");
  await verifyApprovalFile(options.mountApproval, { action: "install_or_mount_plugin", scope: nativeMountScope(plan) });
}
function requestFor(plan: LivePlan, system: string, text: string): TextRequest {
  return { model: plan.model, system, text, credential_store: plan.credential_store, timeout_ms: plan.limits.timeout_ms, output_tokens: plan.limits.output_tokens, output_bytes: plan.limits.output_bytes };
}
function parseReply(text: string): Record<string, unknown> {
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1");
  assertIJsonText(raw);
  const value: unknown = JSON.parse(raw);
  liveAssert(value !== null && typeof value === "object" && !Array.isArray(value), "LIVE_RESPONSE_INVALID");
  scanLive(value);
  return value as Record<string, unknown>;
}

async function call(plan: LivePlan, options: LiveOptions, dependencies: LiveDependencies, operation: string, gen: Generation, phase: LiveOperation["phase"], system: string, text: string): Promise<LiveOperation> {
  liveAssert(/^[a-z][a-z0-9-]{1,127}$/.test(operation), "LIVE_INVALID_OPERATION");
  scanLive({ system, text });
  const request = requestFor(plan, system, text);
  const requestSha = digest(request);
  const root = join(liveRoot(plan.campaign_id), "operations");
  await prepareSafeRepositoryDirectory(root);
  const reservationPath = join(root, `${operation}.intent.json`);
  const receiptPath = join(root, `${operation}.receipt.json`);
  await authorize(plan, options, dependencies, "send_text");
  if (await exists(reservationPath)) {
    const reservation = await readLive<LiveOperation>(reservationPath);
    await assertSchema(SCHEMA_IDS.liveOperation, reservation, "Live reservation");
    liveAssert(reservation.operation === operation && reservation.plan_sha256 === planDigest(plan) && reservation.request_sha256 === requestSha && reservation.generation === gen.id && reservation.phase === phase && reservation.status === "reserved", "LIVE_OPERATION_CONFLICT");
    if (!await exists(receiptPath)) throw new DalError("LIVE_UNKNOWN_EFFECT", "Reserved operation has no terminal receipt; it will not be resent");
    const receipt = await readLive<LiveOperation>(receiptPath);
    await assertSchema(SCHEMA_IDS.liveOperation, receipt, "Live receipt");
    liveAssert(receipt.request_sha256 === requestSha && receipt.operation === operation && receipt.plan_sha256 === planDigest(plan) && receipt.generation === gen.id && receipt.phase === phase, "LIVE_RECEIPT_DRIFT");
    liveAssert(receipt.status === "succeeded" && receipt.response !== null && receipt.response_sha256 === digest(receipt.response), "LIVE_PRIOR_REQUEST_FAILED");
    return receipt;
  }
  const used = (await readdir(root)).filter((name) => name.endsWith(".intent.json")).length;
  liveAssert(used < plan.limits.requests, "LIVE_BUDGET_EXHAUSTED");
  const reservation: LiveOperation = { $schema: SCHEMA_IDS.liveOperation, schema_version: "1.0.0", operation, plan_sha256: planDigest(plan), request_sha256: requestSha, generation: gen.id, phase, status: "reserved", response: null, response_sha256: null, usage: null, error: null };
  await assertSchema(SCHEMA_IDS.liveOperation, reservation, "Live reservation");
  await immutable(reservationPath, reservation);
  // Recheck after the durable claim and immediately before native credential access.
  await authorize(plan, options, dependencies, "send_text");
  try {
    const reply = await dependencies.driver(request);
    liveAssert(Buffer.byteLength(reply.text) <= plan.limits.output_bytes, "LIVE_RESPONSE_LIMIT");
    const response = parseReply(reply.text);
    const receipt: LiveOperation = { ...reservation, status: "succeeded", response, response_sha256: digest(response), usage: reply.usage };
    await assertSchema(SCHEMA_IDS.liveOperation, receipt, "Live receipt");
    await immutable(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const code = error instanceof DalError && /^LIVE_[A-Z_]+$/.test(error.code) ? error.code : "LIVE_RESPONSE_INVALID";
    await immutable(receiptPath, { ...reservation, status: "failed", error: code });
    throw new DalError(code, "Live operation failed; its allocation is retained and it will not be retried");
  }
}

function taskSystem(plan: LivePlan, gen: Generation): string {
  return `You are a tool-free structured-output worker. Return one JSON object without commentary.\nResponse contract:\n${plan.response_contract}\nTask strategy:\n${gen.prompt}`;
}
async function evaluate(plan: LivePlan, options: LiveOptions, dependencies: LiveDependencies, gen: Generation, prefix: string): Promise<Evaluation> {
  const cases: Evaluation["cases"] = [];
  for (const item of plan.cases.filter((item) => item.role !== "canary")) {
    const result = await call(plan, options, dependencies, `${prefix}-${item.id}`, gen, "task", taskSystem(plan, gen), item.input);
    cases.push({ id: item.id, pass: canonicalJson(result.response) === canonicalJson(item.expected), response_sha256: result.response_sha256! });
  }
  const mean = (role: LiveCase["role"]) => {
    const matching = cases.filter((entry) => plan.cases.find((item) => item.id === entry.id)!.role === role);
    return matching.filter((entry) => entry.pass).length / matching.length;
  };
  return { generation: gen.id, development: mean("development"), qualification: mean("qualification"), cases };
}
function selected(plan: LivePlan, state: LiveState): string | null {
  const baseline = state.evaluations[0];
  if (!baseline) return null;
  return state.evaluations.slice(1).filter((candidate) => candidate.qualification - baseline.qualification >= plan.minimum_gain
    && plan.cases.filter((item) => item.role === "qualification").every((item) => !baseline.cases.find((entry) => entry.id === item.id)!.pass || candidate.cases.find((entry) => entry.id === item.id)!.pass))
    .sort((a, b) => b.qualification - a.qualification)[0]?.generation ?? null;
}

export async function runLive(options: LiveOptions, dependencies = native): Promise<LiveState> {
  const plan = await loadPlan(options.campaign);
  await authorize(plan, options, dependencies, "send_text");
  await authorize(plan, options, dependencies, "activate_prompt");
  await authorize(plan, options, dependencies, "rollback_prompt");
  return withLease(plan.campaign_id, async () => {
    let state = await loadState(plan);
    liveAssert(state.phase !== "failed", "LIVE_CAMPAIGN_FAILED");
    // Recover an interrupted journal-to-pointer publication using verified history.
    await atomic(join(liveRoot(plan.campaign_id), "current.json"), { sequence: state.sequence, state_sha256: digest(state), generation: state.active });
    if (["complete", "rolled_back"].includes(state.phase)) return state;
    try {
      if (state.evaluations.length === 0) {
        const baseline = await evaluate(plan, options, dependencies, await generation(plan, sha256(plan.base_prompt)), "baseline");
        state = await saveState(plan, state, { phase: "baseline", evaluations: [baseline] });
      }
      while (state.candidate_index < plan.limits.candidates) {
        const index = state.candidate_index;
        const parent = await generation(plan, selected(plan, state) ?? sha256(plan.base_prompt));
        const observations = [];
        const prior = state.evaluations.find((item) => item.generation === parent.id)!;
        for (const item of plan.cases.filter((item) => item.role === "development")) observations.push({ input: item.input, passed: prior.cases.find((entry) => entry.id === item.id)!.pass });
        const proposal = await call(plan, options, dependencies, `proposal-${index}`, parent, "proposal",
          "Improve a bounded task strategy from development feedback. Return exactly a JSON object with string fields gap, proxy, mechanism, prompt. Diagnose the capability gap, name a measurable development proxy and a falsifiable repair mechanism. The prompt replaces the current task strategy. Do not request tools or modify the response contract. Do not hardcode examples; generalize the rule.",
          canonicalJson({ goal: plan.goal, response_contract: plan.response_contract, current_prompt: parent.prompt, development: observations, maximum_prompt_bytes: plan.limits.prompt_bytes }));
        const value = proposal.response!;
        liveAssert(Object.keys(value).sort().join(",") === "gap,mechanism,prompt,proxy" && Object.values(value).every((entry) => typeof entry === "string" && entry.trim().length > 0), "LIVE_PROPOSAL_INVALID");
        const candidate = await saveGeneration(plan, value.prompt as string, { gap: value.gap as string, proxy: value.proxy as string, mechanism: value.mechanism as string });
        const result = await evaluate(plan, options, dependencies, candidate, `candidate-${index}`);
        state = await saveState(plan, state, { phase: "search", candidate_index: index + 1, evaluations: [...state.evaluations, result] });
      }
      const winner = selected(plan, state);
      if (winner === null || winner === sha256(plan.base_prompt)) return saveState(plan, state, { phase: "complete" });
      if (state.phase !== "probe") {
        await authorize(plan, options, dependencies, "activate_prompt");
        state = await saveState(plan, state, { phase: "probe", active: winner });
      }
      const active = await activeGeneration(plan, state);
      liveAssert(active.id === winner, "LIVE_SELECTION_DRIFT");
      for (const item of plan.cases.filter((item) => item.role === "canary")) {
        const response = await call(plan, options, dependencies, `probe-${item.id}`, active, "task", taskSystem(plan, active), item.input);
        if (canonicalJson(response.response) !== canonicalJson(item.expected)) {
          return saveState(plan, state, { phase: "rolled_back", active: state.retained.at(-1)!, last_error: "LIVE_CANARY_REGRESSION" });
        }
      }
      // An in-flight canary may outlive a revocation or expiry. Final retention is
      // another promotion boundary, so recheck before committing the winner.
      await authorize(plan, options, dependencies, "activate_prompt");
      return saveState(plan, state, { phase: "complete", retained: [...new Set([...state.retained, winner])] });
    } catch (error) {
      // Compensation restores only the exact previously retained generation. It
      // never sends another request, including when authority expired or revoked.
      const code = error instanceof DalError && /^LIVE_[A-Z_]+$/.test(error.code) ? error.code : "LIVE_FAILED";
      state = await saveState(plan, state, { phase: "failed", active: state.retained.at(-1)!, last_error: code });
      throw new DalError(code, "Campaign stopped; prior retained generation is active. Inspect status before starting another campaign.");
    }
  });
}

export async function liveStatus(id: string) {
  const plan = await loadPlan(id);
  const state = await loadState(plan);
  await activeGeneration(plan, state);
  const root = join(liveRoot(id), "operations");
  const names = await exists(root) ? await readdir(root) : [];
  const reserved = names.filter((name) => name.endsWith(".intent.json"));
  const receipts: LiveOperation[] = [];
  for (const name of names.filter((name) => name.endsWith(".receipt.json"))) {
    const value = await readLive<LiveOperation>(join(root, name));
    await assertSchema(SCHEMA_IDS.liveOperation, value, "Live receipt");
    liveAssert(value.plan_sha256 === planDigest(plan) && (value.response === null || value.response_sha256 === digest(value.response)), "LIVE_RECEIPT_DRIFT");
    receipts.push(value);
  }
  return { plan_sha256: planDigest(plan), state, requests_reserved: reserved.length,
    requests_completed: receipts.filter((item) => item.status === "succeeded").length,
    pending: reserved.map((name) => name.replace(".intent.json", "")).filter((id) => !receipts.some((item) => item.operation === id)),
    best_evaluated: [...state.evaluations.slice(1)].sort((a, b) => b.qualification - a.qualification)[0]?.generation ?? null,
    selected_eligible: selected(plan, state), actual_retained: state.active,
    usage: receipts.map((item) => ({ operation: item.operation, usage: item.usage })),
  };
}

export async function rollbackLive(options: LiveOptions, dependencies = native): Promise<LiveState> {
  const plan = await loadPlan(options.campaign);
  await authorize(plan, options, dependencies, "rollback_prompt");
  return withLease(plan.campaign_id, async () => {
    const state = await loadState(plan);
    await activeGeneration(plan, state);
    const target = state.retained.length > 1 ? state.retained[state.retained.length - 2]! : state.retained[0]!;
    return saveState(plan, state, { phase: "rolled_back", active: target, retained: state.retained.slice(0, Math.max(1, state.retained.length - 1)), last_error: null });
  });
}

export async function taskLive(options: LiveOptions, caseId: string, operation: string, dependencies = native) {
  const plan = await loadPlan(options.campaign);
  const item = plan.cases.find((entry) => entry.id === caseId);
  liveAssert(item, "LIVE_UNKNOWN_CASE");
  liveAssert(/^task-[a-z0-9-]{3,80}$/.test(operation), "LIVE_INVALID_OPERATION");
  return withLease(plan.campaign_id, async () => {
    const state = await loadState(plan);
    liveAssert(["complete", "rolled_back"].includes(state.phase), "LIVE_CAMPAIGN_NOT_READY");
    const active = await activeGeneration(plan, state);
    const result = await call(plan, options, dependencies, operation, active, "task", taskSystem(plan, active), item.input);
    return { generation: active.id, operation, passed: canonicalJson(result.response) === canonicalJson(item.expected), response_sha256: result.response_sha256, usage: result.usage };
  });
}

export async function revokeLive(id: string): Promise<void> {
  await loadPlan(id);
  await immutable(join(liveRoot(id), "revoked.json"), { revoked: true });
}

export async function recoverLive(id: string): Promise<void> {
  const plan = await loadPlan(id);
  const path = join(liveRoot(id), "lease.json");
  const lease = await readLive<{ pid: number }>(path);
  await assertSchema(SCHEMA_IDS.liveLease, lease, "Live lease");
  liveAssert(Number.isSafeInteger(lease.pid) && lease.pid > 0, "LIVE_LEASE_INVALID");
  try { process.kill(lease.pid, 0); throw new DalError("LIVE_OWNER_ALIVE", "Campaign owner is still running"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await unlink(path);
  // Pending operation intents deliberately remain; the next run cannot resend them.
  await generation(plan, sha256(plan.base_prompt));
}

/** Synthetic reporting pilot; no competition data or workspace source is included. */
export async function createLiveDemo(id: string, credentialStore = join(homedir(), ".dsh/.credentials.yaml")): Promise<string> {
  const root = liveRoot(id);
  await prepareSafeRepositoryDirectory(root);
  const plan: LivePlan = {
    $schema: SCHEMA_IDS.livePlan, schema_version: "1.0.0", campaign_id: id,
    workspace: await realpath(process.cwd()), runtime_sha256: await nativeRuntimeIdentity(), credential_store: resolve(credentialStore), model: "gpt-5.6-terra",
    goal: "Correctly compare experiment metrics and preserve metric direction across unseen numeric examples.",
    response_contract: "Return exactly two fields: delta (candidate minus baseline as a number) and winner (candidate, baseline, or tie). Higher is better for maximize; lower is better for minimize.",
    base_prompt: "Ignore the numeric inputs. Always return exactly {\"delta\":0,\"winner\":\"tie\"}.",
    cases: [
      { id: "dev-max", role: "development", input: "baseline=10; candidate=14; direction=maximize", expected: { delta: 4, winner: "candidate" } },
      { id: "dev-min", role: "development", input: "baseline=12; candidate=9; direction=minimize", expected: { delta: -3, winner: "candidate" } },
      { id: "qual-max", role: "qualification", input: "baseline=20; candidate=17; direction=maximize", expected: { delta: -3, winner: "baseline" } },
      { id: "qual-min", role: "qualification", input: "baseline=8; candidate=11; direction=minimize", expected: { delta: 3, winner: "baseline" } },
      { id: "canary-tie", role: "canary", input: "baseline=7; candidate=7; direction=minimize", expected: { delta: 0, winner: "tie" } },
    ],
    limits: { candidates: 1, requests: 12, timeout_ms: 60000, output_tokens: 2048, output_bytes: 16384, prompt_bytes: 4096 }, minimum_gain: 0.25,
  };
  const path = join(root, "proposed-plan.json");
  await immutable(path, plan);
  return path;
}
