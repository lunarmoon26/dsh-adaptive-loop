import { open, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DalError } from "./errors.js";
import { assertIJsonText, canonicalJson, publishJsonExclusive, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertNoSymlinkTraversal, prepareSafeRepositoryDirectory, readRepositoryJsonFile, repositoryPathUri } from "./repository.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { ArtifactCampaignPlan, CampaignArtifact, CampaignEvent, CampaignOperation, CampaignProjection, CampaignResult } from "./campaign-types.js";

export type { ArtifactCampaignPlan, CampaignOperation, CampaignProjection } from "./campaign-types.js";
export const campaignDigest = (value: unknown): string => sha256(canonicalJson(value));
function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new DalError(code, code);
}
function scan(value: unknown): void {
  assertNoSecrets(scanSecrets(value));
  assertNoPii(scanPii(value));
  const visit = (item: unknown): void => {
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      ensure(!["__proto__", "prototype", "constructor"].includes(key), "CAMPAIGN_UNSAFE_KEY");
      visit(child);
    }
  };
  visit(value);
}
function root(id: string): string {
  ensure(/^[a-z][a-z0-9-]{2,63}$/.test(id), "CAMPAIGN_INVALID_ID");
  return resolve(".dal/artifact-campaigns", id);
}
async function read<T>(path: string): Promise<T> {
  const document = await readRepositoryJsonFile<T>(repositoryPathUri(path, "Campaign record"), "Campaign record", 2 * 1024 * 1024);
  assertIJsonText(document.raw.toString("utf8"));
  scan(document.value);
  return document.value;
}
/** Input is metadata only. No referenced artifact or evidence bytes are opened. */
export async function readCampaignInput(path: string): Promise<unknown> {
  return read(path);
}
async function lease<T>(id: string, action: () => Promise<T>): Promise<T> {
  const directory = root(id);
  await prepareSafeRepositoryDirectory(directory);
  const path = resolve(directory, "writer.lock");
  await assertNoSymlinkTraversal(path);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch { throw new DalError("CAMPAIGN_BUSY", "Campaign writer lock exists; inspect the owner before manual recovery"); }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
function artifactValid(artifact: CampaignArtifact): void {
  ensure(artifact.locator === `artifact://${artifact.sha256}`, "CAMPAIGN_ARTIFACT_LOCATOR");
}
function unique(values: readonly string[], code: string): void {
  ensure(new Set(values).size === values.length, code);
}
function summary(value: string): void {
  // Narrative fields are reviewed one-line summaries, never payload channels.
  // This rejects common raw/path forms; it cannot prove semantic privacy.
  ensure(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029`{}\[\]]/.test(value)
    && !/(?:^|\s)(?:~?\/|\\\\|[a-z]:[\\/])\S+|file:\/\//i.test(value), "CAMPAIGN_SUMMARY_NOT_METADATA");
}
async function validatePlan(value: unknown): Promise<ArtifactCampaignPlan> {
  await assertSchema(SCHEMA_IDS.artifactCampaignPlan, value, "Artifact campaign plan");
  scan(value);
  const plan = value as ArtifactCampaignPlan;
  summary(plan.goal);
  ensure(plan.limits.parallelism <= plan.limits.attempts, "CAMPAIGN_LIMITS");
  unique(plan.root_artifacts.map(item => item.sha256), "CAMPAIGN_DUPLICATE_ARTIFACT");
  plan.root_artifacts.forEach(artifactValid);
  ensure(plan.root_artifacts.some(item => item.kind === "workspace"), "CAMPAIGN_ROOT_WORKSPACE_REQUIRED");
  return plan;
}
function initial(plan: ArtifactCampaignPlan): CampaignProjection {
  return { plan, plan_sha256: campaignDigest(plan), sequence: 0, head_sha256: null, nodes: [],
    artifacts: plan.root_artifacts.map(item => ({ ...item, producer_node_id: null, accepted: true })),
    reserved: Object.fromEntries(Object.keys(plan.limits.resources).map(key => [key, 0])),
    attempts_remaining: plan.limits.attempts, active: 0, budget_overrun: false, best: null };
}
function sameUnits(actual: object, limits: object): void {
  ensure(Object.keys(actual).sort().join(",") === Object.keys(limits).sort().join(","), "CAMPAIGN_RESOURCE_UNITS");
}
function recordResult(state: CampaignProjection, operation: CampaignResult): void {
  const node = state.nodes.find(item => item.reservation.node_id === operation.node_id);
  ensure(node, "CAMPAIGN_UNKNOWN_NODE");
  if (operation.kind === "result") {
    ensure(node.result === null, "CAMPAIGN_ALREADY_RECORDED");
    ensure(operation.actor.role === "worker" && operation.actor.id === node.reservation.worker_id, "CAMPAIGN_WORKER_MISMATCH");
  } else {
    ensure(node.result?.outcome === "unknown" && operation.outcome !== "unknown", "CAMPAIGN_NOT_UNRESOLVED");
    ensure(operation.actor.role === "supervisor" && operation.actor.id !== node.reservation.worker_id, "CAMPAIGN_SUPERVISOR_REQUIRED");
    for (const previous of node.result.outputs) {
      const current = operation.outputs.find(item => item.sha256 === previous.sha256);
      ensure(current && campaignDigest(current) === campaignDigest(previous), "CAMPAIGN_ARTIFACT_REBIND");
    }
    for (const [key, used] of Object.entries(node.result.usage)) {
      ensure(used === null || (operation.usage[key] !== null && operation.usage[key]! >= used), "CAMPAIGN_USAGE_REGRESSION");
    }
  }
  sameUnits(operation.usage, state.plan.limits.resources);
  unique(operation.outputs.map(item => item.sha256), "CAMPAIGN_DUPLICATE_ARTIFACT");
  unique(operation.metrics.map(item => `${item.name}:${item.context_sha256}`), "CAMPAIGN_DUPLICATE_METRIC");
  ensure(operation.outcome === "completed" || operation.metrics.every(metric => metric.value === null), "CAMPAIGN_INVALID_SCORE");
  for (const artifact of operation.outputs) {
    artifactValid(artifact);
    ensure(!node.reservation.inputs.some(input => input.sha256 === artifact.sha256), "CAMPAIGN_ARTIFACT_CYCLE");
    const known = state.artifacts.find(item => item.sha256 === artifact.sha256);
    if (known) {
      const { producer_node_id, accepted: _accepted, ...descriptor } = known;
      ensure(producer_node_id === operation.node_id && campaignDigest(descriptor) === campaignDigest(artifact), "CAMPAIGN_ARTIFACT_REBIND");
    } else state.artifacts.push({ ...artifact, producer_node_id: operation.node_id, accepted: false });
  }
  for (const [unit, used] of Object.entries(operation.usage)) {
    if (used !== null && used > node.reservation.reservation[unit]!) state.budget_overrun = true;
  }
  node.result = operation;
  state.active = state.nodes.filter(item => item.result === null || item.result.outcome === "unknown").length;
}
function transition(state: CampaignProjection, operation: CampaignOperation): void {
  ensure(operation.campaign_id === state.plan.campaign_id, "CAMPAIGN_ID_MISMATCH");
  if (operation.kind === "reserve") {
    summary(operation.hypothesis);
    ensure(operation.actor.role === "supervisor" && operation.actor.id !== operation.worker_id, "CAMPAIGN_SUPERVISOR_REQUIRED");
    ensure(!state.budget_overrun && state.attempts_remaining > 0, "CAMPAIGN_BUDGET_EXHAUSTED");
    ensure(state.active < state.plan.limits.parallelism, "CAMPAIGN_PARALLELISM_EXHAUSTED");
    ensure(!state.nodes.some(node => node.reservation.node_id === operation.node_id), "CAMPAIGN_DUPLICATE_NODE");
    ensure(operation.round <= state.plan.limits.rounds, "CAMPAIGN_ROUND_LIMIT");
    const parent = operation.parent_id === null ? null : state.nodes.find(node => node.reservation.node_id === operation.parent_id);
    ensure(operation.parent_id === null || (parent?.review && parent.reservation.round < operation.round), "CAMPAIGN_PARENT_NOT_REVIEWED");
    // Once a later round begins, clients cannot backfill earlier rounds.
    ensure(state.nodes.every(node => node.reservation.round <= operation.round), "CAMPAIGN_ROUND_REGRESSION");
    const workspaceSources = parent
      ? [parent.reservation.workspace_sha256, ...state.artifacts.filter(a => a.producer_node_id === operation.parent_id && a.accepted && a.kind === "workspace").map(a => a.sha256)]
      : state.plan.root_artifacts.filter(a => a.kind === "workspace").map(a => a.sha256);
    ensure(workspaceSources.includes(operation.workspace_sha256), "CAMPAIGN_WORKSPACE_LINEAGE");
    unique(operation.inputs.map(input => input.sha256), "CAMPAIGN_DUPLICATE_INPUT");
    ensure(operation.inputs.some(input => input.sha256 === operation.workspace_sha256 && input.kind === "workspace"), "CAMPAIGN_WORKSPACE_INPUT_REQUIRED");
    for (const input of operation.inputs) {
      const artifact = state.artifacts.find(item => item.sha256 === input.sha256);
      ensure(artifact?.accepted && artifact.kind === input.kind && artifact.compatibility_sha256 === input.compatibility_sha256, "CAMPAIGN_INPUT_UNAVAILABLE");
    }
    sameUnits(operation.reservation, state.plan.limits.resources);
    for (const [unit, value] of Object.entries(operation.reservation)) {
      const total = state.reserved[unit]! + value;
      ensure(Number.isSafeInteger(total) && total <= state.plan.limits.resources[unit]!, "CAMPAIGN_BUDGET_EXHAUSTED");
      state.reserved[unit] = total;
    }
    state.nodes.push({ reservation: operation, result: null, review: null });
    state.attempts_remaining -= 1;
    state.active += 1;
  } else if (operation.kind === "result" || operation.kind === "resolve") {
    recordResult(state, operation);
  } else {
    // The explicit cast also makes the union with result/resolve one interface
    // narrow cleanly under TypeScript's exhaustive discriminant rules.
    const review = operation as Extract<CampaignOperation, { kind: "review" }>;
    const node = state.nodes.find(item => item.reservation.node_id === review.node_id);
    ensure(node?.result && node.result.outcome !== "unknown" && !node.review, "CAMPAIGN_NOT_REVIEWABLE");
    ensure(review.actor.role === "supervisor" && review.actor.id !== node.reservation.worker_id, "CAMPAIGN_SUPERVISOR_REQUIRED");
    ensure(review.result_sha256 === campaignDigest(node.result), "CAMPAIGN_STALE_REVIEW");
    unique(review.accepted_artifacts, "CAMPAIGN_DUPLICATE_ARTIFACT");
    for (const id of review.accepted_artifacts) {
      ensure(node.result.outputs.some(artifact => artifact.sha256 === id), "CAMPAIGN_REVIEW_ARTIFACT_MISMATCH");
      state.artifacts.find(artifact => artifact.sha256 === id)!.accepted = true;
    }
    ensure(!review.accept_result || (node.result.outcome === "completed" && review.accepted_artifacts.length === node.result.outputs.length), "CAMPAIGN_RESULT_NOT_ACCEPTABLE");
    node.review = review;
    if (review.accept_result) {
      const metric = node.result.metrics.find(item => item.name === state.plan.metric.name && item.context_sha256 === state.plan.evaluation_context_sha256);
      if (metric?.value !== null && metric?.value !== undefined) {
        const better = state.best === null || (state.plan.metric.direction === "maximize" ? metric.value > state.best.value : metric.value < state.best.value);
        if (better) state.best = { node_id: review.node_id, value: metric.value, result_sha256: review.result_sha256 };
      }
    }
  }
}

async function history(id: string): Promise<{ state: CampaignProjection; events: CampaignEvent[] }> {
  const directory = root(id);
  const plan = await validatePlan(await read(resolve(directory, "plan.json")));
  ensure(plan.campaign_id === id, "CAMPAIGN_ID_MISMATCH");
  const state = initial(plan);
  const eventDirectory = resolve(directory, "events");
  await assertNoSymlinkTraversal(eventDirectory);
  const names = (await readdir(eventDirectory)).filter(name => name.endsWith(".json")).sort();
  ensure(names.length <= plan.limits.attempts * 4, "CAMPAIGN_EVENT_LIMIT");
  const events: CampaignEvent[] = [];
  const ids = new Set<string>();
  for (const name of names) {
    const expected = `${String(state.sequence + 1).padStart(6, "0")}.json`;
    ensure(name === expected, "CAMPAIGN_HISTORY_GAP");
    const event = await read<CampaignEvent>(resolve(eventDirectory, name));
    await assertSchema(SCHEMA_IDS.artifactCampaignEvent, event, "Campaign event");
    ensure(event.sequence === state.sequence + 1 && event.plan_sha256 === state.plan_sha256 && event.previous_sha256 === state.head_sha256, "CAMPAIGN_HISTORY_DRIFT");
    ensure(!ids.has(event.operation.operation_id), "CAMPAIGN_DUPLICATE_OPERATION");
    transition(state, event.operation);
    ids.add(event.operation.operation_id);
    state.sequence = event.sequence;
    state.head_sha256 = campaignDigest(event);
    events.push(event);
  }
  return { state, events };
}

export async function prepareArtifactCampaign(value: unknown): Promise<{ status: string; plan_sha256: string }> {
  const plan = await validatePlan(value);
  return lease(plan.campaign_id, async () => {
    const path = resolve(root(plan.campaign_id), "plan.json");
    await assertNoSymlinkTraversal(path);
    await prepareSafeRepositoryDirectory(resolve(root(plan.campaign_id), "events"));
    const published = await publishJsonExclusive(path, plan);
    if (!published) {
      const current = await history(plan.campaign_id);
      ensure(current.state.plan_sha256 === campaignDigest(plan), "CAMPAIGN_PLAN_CONFLICT");
    }
    return { status: published ? "created" : "idempotent", plan_sha256: campaignDigest(plan) };
  });
}

export async function appendCampaignOperation(value: unknown): Promise<{ status: string; sequence: number; operation_sequence: number; head_sha256: string | null }> {
  await assertSchema(SCHEMA_IDS.artifactCampaignOperation, value, "Campaign operation");
  scan(value);
  const operation = value as CampaignOperation;
  if (operation.kind === "reserve") summary(operation.hypothesis);
  return lease(operation.campaign_id, async () => {
    const { state, events } = await history(operation.campaign_id);
    const previous = events.find(event => event.operation.operation_id === operation.operation_id);
    if (previous) {
      ensure(campaignDigest(previous.operation) === campaignDigest(operation), "CAMPAIGN_OPERATION_CONFLICT");
      return { status: "idempotent", sequence: state.sequence, operation_sequence: previous.sequence, head_sha256: state.head_sha256 };
    }
    transition(state, operation);
    const event: CampaignEvent = { $schema: SCHEMA_IDS.artifactCampaignEvent, schema_version: "1.0.0",
      sequence: state.sequence + 1, plan_sha256: state.plan_sha256, previous_sha256: state.head_sha256, operation };
    await assertSchema(SCHEMA_IDS.artifactCampaignEvent, event, "Campaign event");
    const path = resolve(root(operation.campaign_id), "events", `${String(event.sequence).padStart(6, "0")}.json`);
    await assertNoSymlinkTraversal(path);
    ensure(await publishJsonExclusive(path, event), "CAMPAIGN_EVENT_CONFLICT");
    return { status: "recorded", sequence: event.sequence, operation_sequence: event.sequence, head_sha256: campaignDigest(event) };
  });
}

/** Hold the existing writer lease while a local adapter binds a verified snapshot. */
export async function withArtifactCampaignSnapshot<T>(id: string, action: (state: CampaignProjection) => Promise<T>): Promise<T> {
  return lease(id, async () => action((await history(id)).state));
}

export async function artifactCampaignStatus(id: string, through?: number): Promise<CampaignProjection> {
  return lease(id, async () => {
    const { state, events } = await history(id);
    if (through === undefined) return state;
    ensure(Number.isSafeInteger(through) && through >= 0 && through <= events.length, "CAMPAIGN_INVALID_PREFIX");
    const prefix = initial(state.plan);
    for (const event of events.slice(0, through)) {
      transition(prefix, event.operation);
      prefix.sequence = event.sequence;
      prefix.head_sha256 = campaignDigest(event);
    }
    return prefix;
  });
}
