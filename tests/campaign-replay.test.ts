import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { campaignReplayStatus, prepareCampaignReplay, replayCampaign, type CampaignReplayPlan } from "../src/campaign-replay.js";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/json.js";
import { repositoryPathUri } from "../src/repository.js";
import { SCHEMA_IDS } from "../src/schema.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const parent = resolve(".dal/check");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "campaign-replay-"));
  const id = `campaign-${randomUUID()}`;
  const store = resolve(".dal/campaigns", id);
  cleanup.push(root, store);
  const ref = async (name: string, value: unknown) => {
    const bytes = `${JSON.stringify(value)}\n`;
    const path = join(root, `${name}.json`);
    await writeFile(path, bytes);
    return { uri: repositoryPathUri(path, "Test fixture"), sha256: sha256(bytes) };
  };
  const cases: CampaignReplayPlan["cases"] = [];
  for (let index = 0; index < 5; index++) {
    const caseId = `case-${index}`;
    cases.push({ id: caseId, role: index === 0 ? "development" : "qualification", task: await ref(caseId, {
      $schema: SCHEMA_IDS.workflowTask, schema_version: "1.0.0", task_id: `task-campaign-${index}`,
      domain: "replay", instruction: `Complete fixture ${index}`, initial_state: { answer: "pending" },
      goal_state: { answer: "ok" }, policy_ref: "repo://config/policy.v1.json",
      effect_requirements: { required: [], forbidden: [] },
    }) });
  }
  const generation = async (name: string, values: boolean[], baseline = false) => ({
    id: name, hypothesis_id: baseline ? null : "hypothesis-repair", artifact: await ref(name, { strategy: name }),
    results: await Promise.all(cases.map(async (item, index) => ({
      case_id: item.id, state: await ref(`${name}-${item.id}`, { answer: values[index] ? "ok" : "pending" }), effects: null,
    }))),
  });
  const plan: CampaignReplayPlan = {
    $schema: SCHEMA_IDS.campaignReplay, schema_version: "1.0.0", campaign_id: id, mode: "replay",
    goal: "Improve completion reliability without losing existing capabilities",
    runtime: { provider: "dsh-codex", model: "fixed-test-model", generation_sha256: "a".repeat(64) },
    grader_version: "2.0.0", budget: { max_candidates: 4, max_evaluations: 25 }, minimum_gain: 0.25,
    hypotheses: [{ id: "hypothesis-repair", gap: "Incomplete answers", proxy: "Completion on development cases", mechanism: "Check completion before finishing", surface: "skills", evidence: [await ref("observation", { outcome: "incomplete" })] }],
    cases, baseline: await generation("baseline", [false, true, false, false, false], true),
    candidates: [
      await generation("proxy-only", [true, true, false, false, false]),
      await generation("regressive", [true, false, true, true, true]),
      await generation("winner", [true, true, true, false, false]),
      await generation("no-change", [false, true, false, false, false]),
    ],
  };
  const path = join(root, "plan.json");
  await writeFile(path, JSON.stringify(plan));
  return { root, store, id, plan, path, save: () => writeFile(path, JSON.stringify(plan)) };
}

describe("bounded campaign replay", () => {
  it("replays end to end through the CLI, resumes, and distinguishes proxy, best, eligible and retained", async () => {
    const input = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await runCli(["campaign", "prepare", "--plan", input.path], io)).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.pop()!).evaluations_used).toBe(5);
    const partial = await replayCampaign(input.id, 1);
    expect(partial.evaluated[0]).toMatchObject({ development: 1, raw_delta: 0, eligible: false });
    expect(partial.simulated_retained).toBe("baseline");
    expect(await campaignReplayStatus(input.id)).toEqual(partial);
    const result = await replayCampaign(input.id);
    expect(result.status).toBe("complete");
    expect(result.evaluations_used).toBe(25);
    expect(result.best_evaluated).toBe("regressive");
    expect(result.evaluated[1]).toMatchObject({ raw_delta: 0.5, regressions: ["case-1"], eligible: false });
    expect(result.selected_eligible).toBe("winner");
    expect(result.simulated_retained).toBe("winner");
    expect(result.retained_generation).toBe("baseline");
    expect(result.activation_authorized).toBe(false);
    expect(result.evidence_kind).toBe("replay");
    expect(await replayCampaign(input.id)).toEqual(result);
    const stored = await readFile(join(input.store, "step-004.json"), "utf8");
    expect(stored).not.toContain("Complete fixture");
    expect(stored).not.toContain('"answer"');
    expect(await runCli(["campaign", "status", "--campaign", input.id], io)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual(result);
  });

  it("rejects drift before advancing and rejects forged derived history", async () => {
    const input = await fixture();
    await prepareCampaignReplay(input.path);
    await writeFile(join(input.root, "winner.json"), JSON.stringify({ strategy: "changed" }));
    await expect(replayCampaign(input.id)).rejects.toMatchObject({ code: "CAMPAIGN_INPUT_DRIFT" });
    await writeFile(join(input.root, "winner.json"), `${JSON.stringify({ strategy: "winner" })}\n`);
    const statePath = join(input.store, "step-000.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.baseline.qualification = 1;
    await writeFile(statePath, JSON.stringify(state));
    await expect(campaignReplayStatus(input.id)).rejects.toMatchObject({ code: "CAMPAIGN_HISTORY_DRIFT" });
  });

  it("rejects insufficient allocation and duplicated development/qualification identities", async () => {
    const input = await fixture();
    input.plan.budget.max_evaluations = 24;
    await input.save();
    await expect(prepareCampaignReplay(input.path)).rejects.toMatchObject({ code: "CAMPAIGN_BUDGET_EXCEEDED" });
    input.plan.budget.max_evaluations = 25;
    input.plan.cases[1]!.task = input.plan.cases[0]!.task;
    await input.save();
    await expect(prepareCampaignReplay(input.path)).rejects.toMatchObject({ code: "CAMPAIGN_INVALID" });
  });

  it("allows incumbent retention, idempotent preparation and concurrent deterministic replay", async () => {
    const input = await fixture();
    input.plan.candidates = [input.plan.candidates[0]!, input.plan.candidates[3]!];
    await input.save();
    expect(await prepareCampaignReplay(input.path)).toEqual(await prepareCampaignReplay(input.path));
    const [left, right] = await Promise.all([replayCampaign(input.id), replayCampaign(input.id)]);
    expect(left).toEqual(right);
    expect(left.selected_eligible).toBeNull();
    expect(left.simulated_retained).toBe("baseline");
    expect(left.evaluations_used).toBe(15);
  });

  it("rejects traversal, unsupported live commands, and invalid step limits", async () => {
    await expect(campaignReplayStatus("../other")).rejects.toMatchObject({ code: "CAMPAIGN_INVALID" });
    const input = await fixture();
    await prepareCampaignReplay(input.path);
    await expect(replayCampaign(input.id, 0)).rejects.toMatchObject({ code: "CAMPAIGN_INVALID" });
    const errors: string[] = [];
    expect(await runCli(["campaign", "run", "--campaign", input.id], { stdout: () => {}, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.join("")).toContain("Live execution is unavailable");
  });

  it("recovers initial publication interruption but refuses gaps in later history", async () => {
    const input = await fixture();
    await prepareCampaignReplay(input.path);
    await rm(join(input.store, "step-000.json"));
    expect((await replayCampaign(input.id, 1)).step).toBe(1);
    await replayCampaign(input.id, 1);
    await rm(join(input.store, "step-001.json"));
    await expect(campaignReplayStatus(input.id)).rejects.toMatchObject({ code: "CAMPAIGN_INVALID" });
  });

  it("rejects symlinked and oversized inputs before publishing a plan", async () => {
    const input = await fixture();
    const artifact = join(input.root, "winner.json");
    await rm(artifact);
    await symlink(join(input.root, "baseline.json"), artifact);
    await expect(prepareCampaignReplay(input.path)).rejects.toMatchObject({ code: "REPOSITORY_FILE_READ_FAILED" });
    await rm(artifact);
    await writeFile(artifact, JSON.stringify({ padding: "x".repeat(1024 * 1024) }));
    await expect(prepareCampaignReplay(input.path)).rejects.toMatchObject({ code: "REPOSITORY_FILE_READ_FAILED" });
    await expect(readFile(join(input.store, "plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
