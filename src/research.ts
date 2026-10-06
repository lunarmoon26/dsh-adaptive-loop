import { resolve } from "node:path";
import { withArtifactCampaignSnapshot, campaignDigest } from "./artifact-campaign.js";
import type { CampaignProjection } from "./campaign-types.js";
import { DalError } from "./errors.js";
import { assertIJsonText, jcsCanonicalJson, prettyJson, publishJsonExclusive, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertNoSymlinkTraversal, prepareSafeRepositoryDirectory, readRepositoryFile, repositoryPathUri, resolveRepositoryUri } from "./repository.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";

export interface ResearchMechanism {
  $schema: string;
  schema_version: "1.0.0";
  parent_sha256: string | null;
  instructions: { diagnosis: string; proposal: string };
  search_policy: { strategy: "breadth_first" | "development_first" };
  experience_policy: { selection: "latest_reviewed" | "best_reviewed"; max_items: number };
}
export interface ResearchBinding {
  $schema: string;
  schema_version: "1.0.0";
  campaign_id: string;
  node_id: string;
  mechanism_sha256: string;
  task_contract_uri: string;
  task_harness_sha256: string;
  artifacts: Array<{ sha256: string; uri: string }>;
}
export interface ResearchRequest {
  $schema: string;
  schema_version: "1.0.0";
  binding: ResearchBinding;
  plan_sha256: string;
  ledger: { sequence: number; head_sha256: string };
  reservation_sha256: string;
  worker_id: string;
  workspace_sha256: string;
  resources: Record<string, number>;
  mechanism_sha256: string;
  policy_sha256: string;
  task_harness_sha256: string;
  task_contract_sha256: string;
  instructions: string;
  task_contract: Record<string, unknown>;
  search_policy: ResearchMechanism["search_policy"];
  experience_policy: ResearchMechanism["experience_policy"];
}
export const researchDigest = (value: unknown): string => sha256(jcsCanonicalJson(value));
export const mechanismPolicyDigest = (mechanism: ResearchMechanism): string => researchDigest({ search_policy: mechanism.search_policy, experience_policy: mechanism.experience_policy });

function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new DalError(code, code);
}
function scan(value: unknown): void {
  assertNoSecrets(scanSecrets(value));
  assertNoPii(scanPii(value));
  jcsCanonicalJson(value);
  const visit = (item: unknown): void => {
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      ensure(!["__proto__", "prototype", "constructor"].includes(key), "RESEARCH_UNSAFE_KEY");
      visit(child);
    }
  };
  visit(value);
}
function text(raw: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new DalError("RESEARCH_INVALID_UTF8", "Research instructions and JSON require valid UTF-8"); }
}
async function bytes(uri: string, maximumBytes: number): Promise<Buffer> {
  await assertNoSymlinkTraversal(resolveRepositoryUri(uri, "Research input"), "RESEARCH_INPUT_DENIED", "Research input");
  return readRepositoryFile(uri, "Research input", maximumBytes);
}
async function json<T>(uri: string, maximumBytes = 256 * 1024): Promise<{ value: T; raw: Buffer }> {
  const raw = await bytes(uri, maximumBytes);
  const content = text(raw);
  assertIJsonText(content);
  let value: T;
  try { value = JSON.parse(content) as T; }
  catch { throw new DalError("INVALID_JSON", "Research input is not JSON"); }
  scan(value);
  return { value, raw };
}
const mechanismUri = (id: string) => `repo://.dal/research/mechanisms/${id}.json`;
const requestUri = (binding: ResearchBinding) => `repo://.dal/research/requests/${binding.campaign_id}/${binding.node_id}.json`;

export async function validateResearchMechanism(value: unknown): Promise<ResearchMechanism> {
  await assertSchema(SCHEMA_IDS.researchMechanism, value, "Research mechanism");
  scan(value);
  const mechanism = value as ResearchMechanism;
  ensure(Object.values(mechanism.instructions).every(instruction => instruction.trim().length > 0 && Buffer.byteLength(instruction) <= 20000), "RESEARCH_INSTRUCTION_LIMIT");
  return mechanism;
}
export async function checkResearchMechanism(file: string) {
  const mechanism = await validateResearchMechanism((await json(repositoryPathUri(file, "Research mechanism"))).value);
  return { mechanism_sha256: researchDigest(mechanism), policy_sha256: mechanismPolicyDigest(mechanism) };
}
async function stagedMechanism(id: string): Promise<ResearchMechanism> {
  ensure(/^[a-f0-9]{64}$/.test(id), "RESEARCH_MECHANISM_ID");
  const mechanism = await validateResearchMechanism((await json(mechanismUri(id))).value);
  ensure(researchDigest(mechanism) === id, "RESEARCH_MECHANISM_DRIFT");
  return mechanism;
}
export async function stageResearchMechanism(file: string) {
  const mechanism = await validateResearchMechanism((await json(repositoryPathUri(file, "Research mechanism"))).value);
  const id = researchDigest(mechanism);
  if (mechanism.parent_sha256 !== null) await stagedMechanism(mechanism.parent_sha256);
  const uri = mechanismUri(id);
  await prepareSafeRepositoryDirectory(resolve(".dal/research/mechanisms"));
  const path = resolveRepositoryUri(uri, "Research mechanism destination");
  await assertNoSymlinkTraversal(path);
  const published = await publishJsonExclusive(path, mechanism);
  if (!published) await stagedMechanism(id);
  return { status: published ? "staged" : "idempotent", mechanism_sha256: id, policy_sha256: mechanismPolicyDigest(mechanism), record_uri: uri };
}

async function buildRequest(binding: ResearchBinding, state: CampaignProjection): Promise<ResearchRequest> {
  await assertSchema(SCHEMA_IDS.researchBinding, binding, "Research binding");
  scan(binding);
  const node = state.nodes.find(item => item.reservation.node_id === binding.node_id);
  ensure(node && node.result === null && node.review === null && !state.budget_overrun, "RESEARCH_RESERVATION_NOT_PENDING");
  const mechanism = await stagedMechanism(binding.mechanism_sha256);
  const policy = mechanismPolicyDigest(mechanism);
  ensure(state.plan.researcher_sha256 === binding.mechanism_sha256 && state.plan.policy_sha256 === policy, "RESEARCH_PLAN_MECHANISM_MISMATCH");
  const reservation = node.reservation;
  ensure(binding.artifacts.length === reservation.inputs.length && new Set(binding.artifacts.map(item => item.sha256)).size === binding.artifacts.length, "RESEARCH_INPUT_SET_MISMATCH");
  let harness: string | undefined;
  for (const input of reservation.inputs) {
    const artifact = state.artifacts.find(item => item.sha256 === input.sha256);
    ensure(artifact?.accepted && artifact.kind === input.kind && artifact.compatibility_sha256 === input.compatibility_sha256, "RESEARCH_INPUT_NOT_ACCEPTED");
    const location = binding.artifacts.find(item => item.sha256 === input.sha256);
    ensure(location, "RESEARCH_INPUT_SET_MISMATCH");
    const raw = await bytes(location.uri, input.sha256 === binding.task_harness_sha256 ? 65536 : 16 * 1024 * 1024);
    ensure(sha256(raw) === input.sha256, "RESEARCH_ARTIFACT_DRIFT");
    if (input.sha256 === binding.task_harness_sha256) {
      ensure(input.kind === "task-harness", "RESEARCH_HARNESS_KIND");
      harness = text(raw);
      ensure(harness.trim().length > 0, "RESEARCH_EMPTY_HARNESS");
      scan(harness);
    }
  }
  ensure(harness !== undefined, "RESEARCH_HARNESS_NOT_RESERVED");
  const task = await json<Record<string, unknown>>(binding.task_contract_uri, 65536);
  ensure(sha256(task.raw) === reservation.contract_sha256, "RESEARCH_TASK_CONTRACT_DRIFT");
  ensure(task.value !== null && typeof task.value === "object" && !Array.isArray(task.value), "RESEARCH_TASK_CONTRACT_INVALID");
  const instructions = `[Diagnosis]\n${mechanism.instructions.diagnosis}\n\n[Proposal]\n${mechanism.instructions.proposal}\n\n[Task harness]\n${harness}`;
  const request: ResearchRequest = {
    $schema: SCHEMA_IDS.researchRequest, schema_version: "1.0.0", binding,
    plan_sha256: state.plan_sha256, ledger: { sequence: state.sequence, head_sha256: state.head_sha256! },
    reservation_sha256: campaignDigest(reservation), worker_id: reservation.worker_id,
    workspace_sha256: reservation.workspace_sha256, resources: reservation.reservation,
    mechanism_sha256: binding.mechanism_sha256, policy_sha256: policy,
    task_harness_sha256: binding.task_harness_sha256, task_contract_sha256: reservation.contract_sha256,
    instructions, task_contract: task.value, search_policy: mechanism.search_policy, experience_policy: mechanism.experience_policy,
  };
  await assertSchema(SCHEMA_IDS.researchRequest, request, "Research request");
  scan(request);
  ensure(Buffer.byteLength(prettyJson(request)) <= 512 * 1024, "RESEARCH_REQUEST_LIMIT");
  return request;
}

/** Local preparation only: no dispatch, activation, credentials or extra allocation. */
export async function prepareResearchRequest(file: string) {
  const binding = (await json<ResearchBinding>(repositoryPathUri(file, "Research binding"))).value;
  await assertSchema(SCHEMA_IDS.researchBinding, binding, "Research binding");
  return withArtifactCampaignSnapshot(binding.campaign_id, async state => {
    const request = await buildRequest(binding, state);
    const directory = resolve(".dal/research/requests", binding.campaign_id);
    await prepareSafeRepositoryDirectory(directory);
    const uri = requestUri(binding);
    const path = resolveRepositoryUri(uri, "Research request destination");
    await assertNoSymlinkTraversal(path);
    const published = await publishJsonExclusive(path, request);
    if (!published) {
      const previous = (await json(uri, 512 * 1024)).value;
      await assertSchema(SCHEMA_IDS.researchRequest, previous, "Existing research request");
      ensure(researchDigest(previous) === researchDigest(request), "RESEARCH_REQUEST_CONFLICT");
    }
    return { status: published ? "prepared" : "idempotent", request_sha256: researchDigest(request), record_uri: uri,
      mechanism_sha256: request.mechanism_sha256, task_harness_sha256: request.task_harness_sha256 };
  });
}

/** Adapters must still reverify at dispatch and prove actual runtime consumption. */
export async function verifyResearchRequest(file: string): Promise<ResearchRequest> {
  const request = (await json<ResearchRequest>(repositoryPathUri(file, "Research request"), 512 * 1024)).value;
  await assertSchema(SCHEMA_IDS.researchRequest, request, "Research request");
  return withArtifactCampaignSnapshot(request.binding.campaign_id, async state => {
    const published = (await json(requestUri(request.binding), 512 * 1024)).value;
    await assertSchema(SCHEMA_IDS.researchRequest, published, "Published research request");
    ensure(researchDigest(published) === researchDigest(request), "RESEARCH_REQUEST_NOT_PREPARED");
    const current = await buildRequest(request.binding, state);
    ensure(researchDigest(current) === researchDigest(request), "RESEARCH_REQUEST_DRIFT");
    return current;
  });
}
