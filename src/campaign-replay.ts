import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { DalError } from "./errors.js";
import { canonicalJson, publishJsonExclusive, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertNoSymlinkTraversal, prepareSafeRepositoryDirectory, readRepositoryJsonFile, repositoryPathUri, resolveRepositoryUri } from "./repository.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import { gradeTask, GRADER_VERSION, parseWorkflowEffectLog, type WorkflowTask } from "./workflow-grader.js";

interface Reference { uri: string; sha256: string }
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 32 * MAX_FILE_BYTES;
interface Generation {
  id: string;
  hypothesis_id: string | null;
  artifact: Reference;
  results: Array<{ case_id: string; state: Reference; effects: Reference | null }>;
}
export interface CampaignReplayPlan {
  $schema: string;
  schema_version: "1.0.0";
  campaign_id: string;
  mode: "replay";
  goal: string;
  runtime: { provider: "dsh-codex"; model: string; generation_sha256: string };
  grader_version: string;
  budget: { max_candidates: number; max_evaluations: number };
  minimum_gain: number;
  hypotheses: Array<{ id: string; gap: string; proxy: string; mechanism: string; surface: "skills" | "prompt"; evidence: Reference[] }>;
  cases: Array<{ id: string; role: "development" | "qualification"; task: Reference }>;
  baseline: Generation;
  candidates: Generation[];
}
interface Score {
  generation_id: string;
  hypothesis_id: string | null;
  development: number;
  qualification: number;
  raw_delta: number;
  regressions: string[];
  eligible: boolean;
  cases: Array<{ id: string; pass: boolean; verdict_sha256: string }>;
}
export interface CampaignReplayState {
  $schema: string;
  schema_version: "1.0.0";
  campaign_id: string;
  plan_sha256: string;
  previous_sha256: string | null;
  evidence_kind: "replay";
  step: number;
  status: "prepared" | "replaying" | "complete";
  evaluations_used: number;
  baseline: Score;
  evaluated: Score[];
  best_evaluated: string | null;
  selected_eligible: string | null;
  simulated_retained: string;
  retained_generation: string;
  activation_authorized: false;
  blockers: string[];
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DalError("CAMPAIGN_INVALID", message);
}
function privacy(value: unknown): void {
  assertNoSecrets(scanSecrets(value));
  assertNoPii(scanPii(value));
}
function unique(values: string[], label: string): void {
  requireCondition(new Set(values).size === values.length, `${label} must be unique`);
}
function directory(id: string): string {
  requireCondition(/^[a-z][a-z0-9-]{2,63}$/.test(id), "Invalid campaign identity");
  return resolveRepositoryUri(`repo://.dal/campaigns/${id}`, "Campaign directory");
}
async function readReference(ref: Reference): Promise<{ value: unknown; bytes: number }> {
  const document = await readRepositoryJsonFile<unknown>(ref.uri, "Campaign input", MAX_FILE_BYTES);
  if (sha256(document.raw) !== ref.sha256) throw new DalError("CAMPAIGN_INPUT_DRIFT", "Campaign input bytes changed");
  privacy(document.value);
  return { value: document.value, bytes: document.raw.length };
}

async function validatePlan(value: unknown): Promise<{ plan: CampaignReplayPlan; inputs: Map<string, unknown> }> {
  await assertSchema(SCHEMA_IDS.campaignReplay, value, "Campaign replay plan");
  privacy(value);
  const plan = value as CampaignReplayPlan;
  requireCondition(plan.grader_version === GRADER_VERSION, "Grader version does not match this build");
  unique(plan.hypotheses.map((hypothesis) => hypothesis.id), "Hypothesis identities");
  unique(plan.cases.map((item) => item.id), "Case identities");
  unique([plan.baseline, ...plan.candidates].map((item) => item.id), "Generation identities");
  unique(plan.cases.map((item) => item.task.sha256), "Task contents across development and qualification");
  requireCondition(plan.cases.some((item) => item.role === "development") && plan.cases.some((item) => item.role === "qualification"), "Both development and qualification cases are required");
  requireCondition(plan.baseline.hypothesis_id === null, "Baseline cannot claim a repair hypothesis");
  requireCondition(plan.candidates.every((item) => plan.hypotheses.some((hypothesis) => hypothesis.id === item.hypothesis_id)), "Candidate hypothesis is missing");
  if (plan.candidates.length > plan.budget.max_candidates || (plan.candidates.length + 1) * plan.cases.length > plan.budget.max_evaluations) {
    throw new DalError("CAMPAIGN_BUDGET_EXCEEDED", "Replay allocation includes baseline and every candidate-case evaluation");
  }
  const references = [...plan.cases.map((item) => item.task), ...plan.hypotheses.flatMap((item) => item.evidence)];
  const caseIds = plan.cases.map((item) => item.id).sort();
  for (const generation of [plan.baseline, ...plan.candidates]) {
    requireCondition(canonicalJson(generation.results.map((item) => item.case_id).sort()) === canonicalJson(caseIds), "Each generation requires exactly one result per case");
    references.push(generation.artifact);
    for (const result of generation.results) {
      references.push(result.state);
      if (result.effects !== null) references.push(result.effects);
    }
  }
  const inputs = new Map<string, unknown>();
  const digests = new Map<string, string>();
  let inputBytes = 0;
  for (const ref of references) {
    requireCondition(!digests.has(ref.uri) || digests.get(ref.uri) === ref.sha256, "One input URI has conflicting digests");
    digests.set(ref.uri, ref.sha256);
    if (!inputs.has(ref.uri)) {
      const input = await readReference(ref);
      inputBytes += input.bytes;
      requireCondition(inputBytes <= MAX_INPUT_BYTES, "Campaign exceeds the aggregate input byte limit");
      inputs.set(ref.uri, input.value);
    }
  }
  const taskIds: string[] = [];
  for (const item of plan.cases) {
    const task = inputs.get(item.task.uri);
    await assertSchema(SCHEMA_IDS.workflowTask, task, "Campaign task");
    taskIds.push((task as WorkflowTask).task_id);
  }
  unique(taskIds, "Task identities across development and qualification");
  return { plan, inputs };
}

function score(plan: CampaignReplayPlan, generation: Generation, inputs: Map<string, unknown>, baseline?: Score): Score {
  const cases = plan.cases.map((item) => {
    const result = generation.results.find((entry) => entry.case_id === item.id)!;
    let effects;
    if (result.effects !== null) {
      const value = inputs.get(result.effects.uri);
      requireCondition(Array.isArray(value), "Replay effects must be a JSON array");
      effects = parseWorkflowEffectLog(value.map((entry) => JSON.stringify(entry)).join("\n"));
    }
    const verdict = gradeTask(inputs.get(item.task.uri) as WorkflowTask, inputs.get(result.state.uri), effects);
    return { id: item.id, pass: verdict.pass, verdict_sha256: sha256(canonicalJson(verdict)) };
  });
  const mean = (role: "development" | "qualification") => {
    const selected = cases.filter((item) => plan.cases.find((entry) => entry.id === item.id)!.role === role);
    return selected.filter((item) => item.pass).length / selected.length;
  };
  const qualification = mean("qualification");
  const regressions = cases.filter((item) => !item.pass && plan.cases.find((entry) => entry.id === item.id)!.role === "qualification" && baseline?.cases.find((entry) => entry.id === item.id)?.pass).map((item) => item.id);
  const delta = baseline === undefined ? 0 : qualification - baseline.qualification;
  return {
    generation_id: generation.id, hypothesis_id: generation.hypothesis_id,
    development: mean("development"), qualification, raw_delta: delta, regressions,
    eligible: baseline !== undefined && regressions.length === 0 && delta >= plan.minimum_gain,
    cases,
  };
}

function snapshot(plan: CampaignReplayPlan, inputs: Map<string, unknown>, step: number, previous: CampaignReplayState | null): CampaignReplayState {
  const baseline = previous?.baseline ?? score(plan, plan.baseline, inputs);
  const evaluated = step === 0 ? [] : [...previous!.evaluated, score(plan, plan.candidates[step - 1]!, inputs, baseline)];
  // Stable sorting is the declared tie-break: earlier candidates win ties.
  const ranked = [...evaluated].sort((a, b) => b.qualification - a.qualification);
  const selected = ranked.find((item) => item.eligible)?.generation_id ?? null;
  return {
    $schema: SCHEMA_IDS.campaignReplayState, schema_version: "1.0.0", campaign_id: plan.campaign_id,
    plan_sha256: sha256(canonicalJson(plan)), previous_sha256: previous === null ? null : sha256(canonicalJson(previous)),
    evidence_kind: "replay", step, status: step === 0 ? "prepared" : step === plan.candidates.length ? "complete" : "replaying",
    evaluations_used: (step + 1) * plan.cases.length, baseline, evaluated,
    best_evaluated: ranked[0]?.generation_id ?? null, selected_eligible: selected,
    simulated_retained: selected ?? plan.baseline.id, retained_generation: plan.baseline.id,
    activation_authorized: false,
    blockers: ["LIVE_CAMPAIGN_EXECUTOR_UNAVAILABLE", "LOCAL_ACTIVATION_UNAVAILABLE"],
  };
}

async function publish(path: string, value: unknown): Promise<void> {
  await assertNoSymlinkTraversal(path);
  if (!await publishJsonExclusive(path, value)) {
    const existing = await readRepositoryJsonFile<unknown>(repositoryPathUri(path, "Campaign record"), "Campaign record", MAX_FILE_BYTES);
    if (canonicalJson(existing.value) !== canonicalJson(value)) throw new DalError("CAMPAIGN_CONFLICT", "Immutable campaign record conflicts");
  }
}
const stepName = (step: number) => `step-${String(step).padStart(3, "0")}.json`;

export async function prepareCampaignReplay(planPath: string): Promise<CampaignReplayState> {
  const document = await readRepositoryJsonFile<unknown>(repositoryPathUri(planPath, "Campaign plan"), "Campaign plan", MAX_FILE_BYTES);
  const { plan, inputs } = await validatePlan(document.value);
  const root = directory(plan.campaign_id);
  await prepareSafeRepositoryDirectory(root);
  await publish(join(root, "plan.json"), plan);
  const initial = snapshot(plan, inputs, 0, null);
  await assertSchema(SCHEMA_IDS.campaignReplayState, initial, "Campaign state");
  await publish(join(root, stepName(0)), initial);
  return initial;
}

async function loadCampaign(id: string) {
  const root = directory(id);
  await assertNoSymlinkTraversal(root);
  const document = await readRepositoryJsonFile<unknown>(repositoryPathUri(join(root, "plan.json"), "Campaign plan"), "Campaign plan", MAX_FILE_BYTES);
  const { plan, inputs } = await validatePlan(document.value);
  requireCondition(plan.campaign_id === id, "Stored plan identity does not match campaign");
  const names = (await readdir(root)).filter((name) => !name.endsWith(".tmp") && name !== "plan.json").sort();
  let state = snapshot(plan, inputs, 0, null);
  requireCondition(names.length <= plan.candidates.length + 1, "Campaign has excess history");
  for (const [index, name] of names.entries()) {
    requireCondition(name === stepName(index), "Campaign history is incomplete or contains unknown files");
    if (index > 0) state = snapshot(plan, inputs, index, state);
    const saved = await readRepositoryJsonFile<unknown>(repositoryPathUri(join(root, name), "Campaign state"), "Campaign state", MAX_FILE_BYTES);
    await assertSchema(SCHEMA_IDS.campaignReplayState, saved.value, "Campaign state");
    if (canonicalJson(saved.value) !== canonicalJson(state)) throw new DalError("CAMPAIGN_HISTORY_DRIFT", "Campaign history does not match replayed inputs");
  }
  return { root, plan, inputs, state };
}

export async function campaignReplayStatus(id: string): Promise<CampaignReplayState> {
  return (await loadCampaign(id)).state;
}

export async function replayCampaign(id: string, steps = 32): Promise<CampaignReplayState> {
  requireCondition(Number.isInteger(steps) && steps > 0 && steps <= 32, "Steps must be an integer between 1 and 32");
  const { root, plan, inputs, state: current } = await loadCampaign(id);
  let state = current;
  // Recover a crash after plan publication but before the initial snapshot.
  if (state.step === 0) await publish(join(root, stepName(0)), state);
  const target = Math.min(plan.candidates.length, state.step + steps);
  while (state.step < target) {
    state = snapshot(plan, inputs, state.step + 1, state);
    await assertSchema(SCHEMA_IDS.campaignReplayState, state, "Campaign state");
    await publish(join(root, stepName(state.step)), state);
  }
  return state;
}
