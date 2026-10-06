import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendCampaignOperation, artifactCampaignStatus, campaignDigest, prepareArtifactCampaign } from "../src/artifact-campaign.js";
import type { ArtifactCampaignPlan, CampaignArtifact, CampaignOperation, CampaignReservation, CampaignResult, CampaignReview } from "../src/campaign-types.js";
import { runCli } from "../src/cli.js";

const fixtures = fileURLToPath(new URL("./fixtures/artifact-campaign/", import.meta.url));
const operationFiles = ["01-feature-reserve.json", "02-feature-result.json", "03-feature-review.json", "04-train-reserve.json", "05-train-result.json", "06-train-review.json"];
const digest = (letter: string) => letter.repeat(64);
const input = ({ sha256, kind, compatibility_sha256 }: CampaignArtifact) => ({ sha256, kind, compatibility_sha256 });

describe("artifact campaign evidence ledger", () => {
  let cwd: string;
  let directory: string;
  let plan: ArtifactCampaignPlan;
  let operations: CampaignOperation[];
  let reserve: CampaignReservation;
  let result: CampaignResult;
  let review: CampaignReview;
  let child: CampaignReservation;
  let childResult: CampaignResult;
  let childReview: CampaignReview;
  const append = appendCampaignOperation;
  const status = () => artifactCampaignStatus(plan.campaign_id);
  const store = () => join(directory, ".dal/artifact-campaigns", plan.campaign_id);
  const eventPath = (sequence: number) => join(store(), "events", `${String(sequence).padStart(6, "0")}.json`);
  async function seed(count = 6) {
    await prepareArtifactCampaign(plan);
    for (const operation of operations.slice(0, count)) await append(operation);
  }
  function sibling(name = "train-sibling"): CampaignReservation {
    return { ...structuredClone(child), node_id: name, operation_id: `reserve-${name}` };
  }
  function completed(node: CampaignReservation, value = 0.9): CampaignResult {
    return { ...structuredClone(childResult), node_id: node.node_id, operation_id: `result-${node.node_id}`, actor: { id: node.worker_id, role: "worker" }, outputs: [], metrics: [{ name: plan.metric.name, value, context_sha256: plan.evaluation_context_sha256 }] };
  }
  function reviewed(value: CampaignResult, accept = true): CampaignReview {
    return { ...structuredClone(review), node_id: value.node_id, operation_id: `review-${value.node_id}`, result_sha256: campaignDigest(value), accept_result: accept, accepted_artifacts: value.outputs.map(item => item.sha256) };
  }

  beforeEach(async () => {
    cwd = process.cwd();
    directory = await mkdtemp(join(tmpdir(), "dal-artifact-campaign-"));
    plan = JSON.parse(await readFile(join(fixtures, "plan.json"), "utf8"));
    operations = await Promise.all(operationFiles.map(async file => JSON.parse(await readFile(join(fixtures, file), "utf8")) as CampaignOperation));
    [reserve, result, review, child, childResult, childReview] = operations as [CampaignReservation, CampaignResult, CampaignReview, CampaignReservation, CampaignResult, CampaignReview];
    process.chdir(directory);
  });
  afterEach(async () => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("projects the multiround fixture tree and shares one produced feature cache across siblings", async () => {
    expect(review.result_sha256).toBe(campaignDigest(result));
    expect(childReview.result_sha256).toBe(campaignDigest(childResult));
    await seed();
    const other = sibling();
    await append(other);
    const tree = await status();
    expect(tree.nodes.map(node => [node.reservation.node_id, node.reservation.parent_id, node.reservation.round])).toEqual([
      [reserve.node_id, null, 1], [child.node_id, reserve.node_id, 2], [other.node_id, reserve.node_id, 2],
    ]);
    expect(tree.nodes.slice(1).map(node => node.reservation.inputs)).toEqual([child.inputs, child.inputs]);
    expect(tree.artifacts.filter(item => item.kind === "feature-cache")).toEqual([{ ...result.outputs[0], producer_node_id: reserve.node_id, accepted: true }]);
    expect(tree.reserved).toEqual({ compute_seconds: 500 });
    expect(tree.best).toEqual({ node_id: child.node_id, value: 0.75, result_sha256: campaignDigest(childResult) });
  });

  it("refuses duplicate production and claiming an input as a new output", async () => {
    await seed(3);
    const other = { ...sibling(), inputs: [child.inputs[0]!] };
    await append(other);
    await expect(append({ ...completed(other), outputs: result.outputs })).rejects.toMatchObject({ code: "CAMPAIGN_ARTIFACT_REBIND" });
    await expect(append({ ...completed(other), outputs: plan.root_artifacts })).rejects.toMatchObject({ code: "CAMPAIGN_ARTIFACT_CYCLE" });
    expect((await status()).sequence).toBe(4);
  });

  it("does not confuse completion with acceptance", async () => {
    await seed(5);
    const tree = await status();
    expect(tree.best).toBeNull();
    expect(tree.nodes[1]!.review).toBeNull();
    expect(tree.artifacts.find(item => item.sha256 === childResult.outputs[0]!.sha256)?.accepted).toBe(false);
    await append(childReview);
    expect((await status()).best?.value).toBe(0.75);
  });

  it.each(["rejected", "different-context", "different-name"])("keeps %s diagnostic metrics out of the accepted comparable incumbent", async mode => {
    await seed();
    const other = sibling();
    await append(other);
    const diagnostic = completed(other, 0.99);
    if (mode === "different-context") diagnostic.metrics[0]!.context_sha256 = digest("0");
    if (mode === "different-name") diagnostic.metrics[0]!.name = "diagnostic-score";
    await append(diagnostic);
    await append(reviewed(diagnostic, mode !== "rejected"));
    const tree = await status();
    expect(tree.best?.node_id).toBe(child.node_id);
    expect(tree.nodes[2]!.result!.metrics[0]!.value).toBe(0.99);
  });

  it.each(["maximize", "minimize"] as const)("selects accepted comparable metrics in the %s direction", async direction => {
    plan.metric.direction = direction;
    await seed();
    const other = sibling();
    const better = completed(other, direction === "maximize" ? 0.8 : 0.7);
    await append(other);
    await append(better);
    expect((await status()).best?.node_id).toBe(child.node_id);
    await append(reviewed(better));
    expect((await status()).best?.node_id).toBe(other.node_id);
  });

  it("refuses unreviewed parents, unaccepted inputs and wrong compatibility", async () => {
    await seed(2);
    await expect(append(child)).rejects.toMatchObject({ code: "CAMPAIGN_PARENT_NOT_REVIEWED" });
    await expect(append({ ...child, parent_id: null })).rejects.toMatchObject({ code: "CAMPAIGN_INPUT_UNAVAILABLE" });
    await append(review);
    const incompatible = structuredClone(child);
    incompatible.inputs[1]!.compatibility_sha256 = digest("0");
    await expect(append(incompatible)).rejects.toMatchObject({ code: "CAMPAIGN_INPUT_UNAVAILABLE" });
    expect((await status()).sequence).toBe(3);
  });

  it("freezes the plan, root workspace and primary-parent workspace identity", async () => {
    const alternative = { ...plan.root_artifacts[0]!, sha256: digest("0"), locator: `artifact://${digest("0")}` };
    plan.root_artifacts.push(alternative);
    await seed(3);
    await expect(prepareArtifactCampaign({ ...plan, policy_sha256: digest("f") })).rejects.toMatchObject({ code: "CAMPAIGN_PLAN_CONFLICT" });
    await expect(append({ ...child, workspace_sha256: alternative.sha256, inputs: [input(alternative)] })).rejects.toMatchObject({ code: "CAMPAIGN_WORKSPACE_LINEAGE" });
    await expect(append({ ...child, parent_id: "missing-parent" })).rejects.toMatchObject({ code: "CAMPAIGN_PARENT_NOT_REVIEWED" });
    await expect(append({ ...sibling(), parent_id: null, workspace_sha256: digest("e") })).rejects.toMatchObject({ code: "CAMPAIGN_WORKSPACE_LINEAGE" });
    await append(child);
    await expect(append({ ...child, parent_id: null })).rejects.toMatchObject({ code: "CAMPAIGN_OPERATION_CONFLICT" });
    expect((await status()).nodes[1]!.reservation.parent_id).toBe(reserve.node_id);
  });

  it("rejects stale result digests and worker self-review", async () => {
    await seed(2);
    await expect(append({ ...review, result_sha256: digest("0") })).rejects.toMatchObject({ code: "CAMPAIGN_STALE_REVIEW" });
    await expect(append({ ...review, actor: { id: reserve.worker_id, role: "supervisor" } })).rejects.toMatchObject({ code: "CAMPAIGN_SUPERVISOR_REQUIRED" });
    await expect(append({ ...review, actor: { id: "another-worker", role: "worker" } })).rejects.toMatchObject({ code: "CAMPAIGN_SUPERVISOR_REQUIRED" });
    expect((await status()).nodes[0]!.review).toBeNull();
  });

  it("holds unknown work in its parallel slot until a distinct supervisor resolves it", async () => {
    plan.limits.parallelism = 1;
    await seed(1);
    const unknown: CampaignResult = { ...result, outcome: "unknown", usage: { compute_seconds: null } };
    await append(unknown);
    const next = { ...reserve, operation_id: "reserve-next", node_id: "next-node" };
    await expect(append(next)).rejects.toMatchObject({ code: "CAMPAIGN_PARALLELISM_EXHAUSTED" });
    await expect(append(reviewed(unknown))).rejects.toMatchObject({ code: "CAMPAIGN_NOT_REVIEWABLE" });
    const resolution: CampaignResult = { ...result, kind: "resolve", operation_id: "resolve-feature", actor: review.actor, outcome: "failed" };
    await expect(append({ ...resolution, actor: result.actor })).rejects.toMatchObject({ code: "CAMPAIGN_SUPERVISOR_REQUIRED" });
    expect((await status()).active).toBe(1);
    await append(resolution);
    expect((await status()).active).toBe(0);
    await append(next);
    expect((await status()).active).toBe(1);
  });

  it("preserves timed-out null metrics and permits independently reviewed checkpoint reuse", async () => {
    await seed(1);
    const timeout: CampaignResult = { ...result, outcome: "timed_out", outputs: childResult.outputs, metrics: [{ ...childResult.metrics[0]!, value: null }] };
    await append(timeout);
    await expect(append(reviewed(timeout))).rejects.toMatchObject({ code: "CAMPAIGN_RESULT_NOT_ACCEPTABLE" });
    await append(reviewed(timeout, false));
    await append({ ...child, inputs: [child.inputs[0]!, input(timeout.outputs[0]!)] });
    const tree = await status();
    expect(tree.nodes[0]!.result!.metrics[0]!.value).toBeNull();
    expect(tree.nodes[0]!.review!.accept_result).toBe(false);
    expect(tree.best).toBeNull();
    expect(tree.artifacts.find(item => item.sha256 === timeout.outputs[0]!.sha256)?.accepted).toBe(true);
  });

  it("refuses over-allocation and never refunds failed reservations", async () => {
    plan.limits.resources.compute_seconds = 100;
    await prepareArtifactCampaign(plan);
    await expect(append({ ...reserve, reservation: { compute_seconds: 101 } })).rejects.toMatchObject({ code: "CAMPAIGN_BUDGET_EXHAUSTED" });
    expect((await status()).reserved.compute_seconds).toBe(0);
    await append(reserve);
    await append({ ...result, outcome: "failed", outputs: [], usage: { compute_seconds: 0 } });
    await expect(append({ ...reserve, operation_id: "reserve-next", node_id: "next-node", reservation: { compute_seconds: 1 } })).rejects.toMatchObject({ code: "CAMPAIGN_BUDGET_EXHAUSTED" });
    expect(await status()).toMatchObject({ reserved: { compute_seconds: 100 }, attempts_remaining: 3, active: 0 });
  });

  it("records truthful usage overruns and blocks future reservations", async () => {
    await seed(1);
    await append({ ...result, usage: { compute_seconds: 101 } });
    const tree = await status();
    expect(tree.budget_overrun).toBe(true);
    expect(tree.nodes[0]!.result!.usage.compute_seconds).toBe(101);
    expect(tree.reserved.compute_seconds).toBe(100);
    await expect(append({ ...reserve, operation_id: "reserve-next", node_id: "next-node" })).rejects.toMatchObject({ code: "CAMPAIGN_BUDGET_EXHAUSTED" });
  });

  it("makes identical operation retries idempotent, including after later events, and rejects conflicting IDs", async () => {
    await prepareArtifactCampaign(plan);
    expect(await prepareArtifactCampaign(plan)).toMatchObject({ status: "idempotent", plan_sha256: campaignDigest(plan) });
    const first = await append(reserve);
    await append(result);
    const current = await status();
    expect(await append(structuredClone(reserve))).toEqual({ status: "idempotent", sequence: 2,
      operation_sequence: first.operation_sequence, head_sha256: current.head_sha256 });
    await expect(append({ ...reserve, hypothesis: "A different synthetic hypothesis." })).rejects.toMatchObject({ code: "CAMPAIGN_OPERATION_CONFLICT" });
    expect((await status()).sequence).toBe(2);
    expect(await readdir(join(store(), "events"))).toHaveLength(2);
    expect(campaignDigest({ a: 1, b: 2 })).toBe(campaignDigest({ b: 2, a: 1 }));
  });

  it("reconstructs after module restart and does not expose future outcomes in a prefix", async () => {
    await seed(4);
    const before = await status();
    await append(childResult);
    await append(childReview);
    const full = await status();
    vi.resetModules();
    const restarted = await import("../src/artifact-campaign.js");
    expect(await restarted.artifactCampaignStatus(plan.campaign_id)).toEqual(full);
    expect(await restarted.artifactCampaignStatus(plan.campaign_id, 4)).toEqual(before);
    expect(await restarted.artifactCampaignStatus(plan.campaign_id, 0)).toMatchObject({ sequence: 0, nodes: [], best: null, active: 0 });
    for (const through of [-1, 1.5, 7]) {
      await expect(artifactCampaignStatus(plan.campaign_id, through)).rejects.toMatchObject({ code: "CAMPAIGN_INVALID_PREFIX" });
    }
  });

  it.each(["tamper", "missing"])("detects %s in the persisted hash chain", async mode => {
    await seed();
    if (mode === "missing") await unlink(eventPath(2));
    else {
      const event = JSON.parse(await readFile(eventPath(1), "utf8"));
      event.operation.hypothesis = "Changed synthetic metadata.";
      await writeFile(eventPath(1), JSON.stringify(event));
    }
    const code = mode === "missing" ? "CAMPAIGN_HISTORY_GAP" : "CAMPAIGN_HISTORY_DRIFT";
    await expect(status()).rejects.toMatchObject({ code });
    await expect(append(sibling())).rejects.toMatchObject({ code });
  });

  it("rejects synthetic secret markers before creating a plan or appending any event", async () => {
    const marker = "-----BEGIN PRIVATE KEY-----";
    await expect(prepareArtifactCampaign({ ...plan, goal: marker })).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    expect(await readdir(directory)).toEqual([]);
    await seed(1);
    const before = await readFile(eventPath(1), "utf8");
    await expect(append({ ...reserve, operation_id: "reserve-private", node_id: "private-node", hypothesis: marker })).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    expect(await readdir(join(store(), "events"))).toEqual(["000001.json"]);
    expect(await readFile(eventPath(1), "utf8")).toBe(before);
    expect(await readdir(store())).not.toContain("writer.lock");
  });

  it("refuses a held writer lease and releases its own lease after validation failure", async () => {
    await prepareArtifactCampaign(plan);
    const lock = join(store(), "writer.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    await expect(append(reserve)).rejects.toMatchObject({ code: "CAMPAIGN_BUSY" });
    expect(await readdir(join(store(), "events"))).toEqual([]);
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual({ pid: process.pid });
    await unlink(lock);
    await expect(append({ ...reserve, reservation: { compute_seconds: 1001 } })).rejects.toMatchObject({ code: "CAMPAIGN_BUDGET_EXHAUSTED" });
    expect(await append(reserve)).toMatchObject({ status: "recorded", sequence: 1 });
  });

  it.each(["inspect /tmp/private/workspace", "file:///private/input", "raw\ntranscript", "values [1,2,3]", "`source code`", "raw\u2028transcript", "\\\\server\\share\\private"])("rejects raw-form summary %s before persistence", async goal => {
    await expect(prepareArtifactCampaign({ ...plan, goal })).rejects.toMatchObject({ code: "CAMPAIGN_SUMMARY_NOT_METADATA" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("serializes competing appends without duplicate events and allows a busy writer to retry", async () => {
    await prepareArtifactCampaign(plan);
    const results = await Promise.allSettled([append(reserve), append(reserve)]);
    expect(results.filter(item => item.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const item of results) {
      if (item.status === "rejected") expect(item.reason).toMatchObject({ code: "CAMPAIGN_BUSY" });
    }
    expect(await append(reserve)).toMatchObject({ status: "idempotent", sequence: 1 });
    expect((await status()).nodes).toHaveLength(1);
    expect(await readdir(join(store(), "events"))).toEqual(["000001.json"]);
  });

  it("supports CLI create, append and historical tree using local metadata only", async () => {
    await writeFile("plan.json", JSON.stringify(plan));
    await writeFile("operation.json", JSON.stringify(reserve));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
    expect(await runCli(["campaign", "create", "--plan", "plan.json"], io)).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ status: "created" });
    expect(await runCli(["campaign", "append", "--operation", "operation.json"], io)).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ status: "recorded", sequence: 1 });
    expect(await runCli(["campaign", "tree", "--campaign", plan.campaign_id], io)).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ sequence: 1, nodes: [{ reservation: reserve }] });
    expect(await runCli(["campaign", "tree", "--campaign", plan.campaign_id, "--through", "0"], io)).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ sequence: 0, nodes: [] });
    expect(stderr).toEqual([]);
  });
});
