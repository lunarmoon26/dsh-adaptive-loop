import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planDigest, nativeMountScope } from "../src/live/authority.js";
import { dreamLive, liveReview, liveStatus, prepareLive, promoteLive, recoverLive, rejectLive, revokeLive, rollbackLive, runLive, taskLive, type LiveDependencies } from "../src/live/loop.js";
import { serveLiveReviewDashboard } from "../src/live/dashboard.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { replayDiscoveryTree } from "../src/live/dream.js";
import { SCHEMA_IDS } from "../src/schema.js";
import type { CampaignGrant, LiveDiscoveryNode, LiveExplorationPolicy, LivePlan, TextRequest } from "../src/live/types.js";
import { runCli } from "../src/cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(config: { candidates?: number; explorationPolicy?: LiveExplorationPolicy } = {}) {
  await mkdir(resolve(".dal/check"), { recursive: true });
  const root = await mkdtemp(resolve(".dal/check/live-test-"));
  const campaign = `live-${randomUUID()}`;
  const store = resolve(".dal/live", campaign);
  roots.push(root, store);
  const candidates = config.candidates ?? 1;
  const plan: LivePlan = {
    $schema: SCHEMA_IDS.livePlan, schema_version: "1.0.0", campaign_id: campaign, workspace: await realpath(process.cwd()), runtime_sha256: "c".repeat(64), credential_store: "/fixture/native-store.yaml", model: "synthetic",
    goal: "Improve completion", response_contract: "Return one object with answer as a string", base_prompt: "weak strategy",
    cases: [
      { id: "dev-task", role: "development", input: "Development input", expected: { answer: "private-oracle" } },
      { id: "qual-task", role: "qualification", input: "Qualification input", expected: { answer: "private-oracle" } },
      { id: "canary-task", role: "canary", input: "Canary input", expected: { answer: "private-oracle" } },
    ],
    limits: { candidates, requests: Math.max(9, (3 * candidates) + 3), timeout_ms: 1000, output_tokens: 128, output_bytes: 4096, prompt_bytes: 2048 }, minimum_gain: 0.5,
    ...(config.explorationPolicy === undefined ? {} : { exploration_policy: config.explorationPolicy }),
  };
  const path = join(root, "plan.json");
  await writeFile(path, JSON.stringify(plan));
  const grant: CampaignGrant = { $schema: SCHEMA_IDS.campaignGrant, schema_version: "1.0.0", decision_id: "dec-fixture-live", decision: "approved", reviewer: { kind: "human", id: "fixture-human" }, plan_sha256: planDigest(plan), actions: ["send_text", "activate_prompt", "rollback_prompt"], decided_at: new Date(Date.now() - 10000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  const options = { campaign, grant: join(root, "grant.json"), mountApproval: join(root, "mount.json") };
  await writeFile(options.grant, JSON.stringify(grant));
  const scope = nativeMountScope(plan);
  await writeFile(options.mountApproval, JSON.stringify({
    $schema: SCHEMA_IDS.approval, schema_version: "1.0.0", decision_id: "dec-fixture-mount", request_id: "req-fixture-mount", action: "install_or_mount_plugin", scope: { kind: "plugin", value: scope, sha256: sha256(scope) }, decision: "approved", reviewer: { kind: "human", id: "fixture-human" }, decided_at: grant.decided_at, expires_at: grant.expires_at, rationale: "Synthetic driver only", evidence: ["repo://tests/live-loop.test.ts"], candidate_sha256: null,
  }));
  const requests: TextRequest[] = [];
  const dependencies: LiveDependencies = {
    runtimeIdentity: async () => plan.runtime_sha256,
    driver: vi.fn(async (request) => {
      requests.push(request);
      const response = request.system.startsWith("Improve a bounded")
        ? { gap: "Incomplete answers", proxy: "Development completion", mechanism: "Verify completion", prompt: "optimized strategy" }
        : { answer: request.system.includes("weak strategy") ? "wrong" : "private-oracle" };
      return { text: JSON.stringify(response), usage: { input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 } };
    }),
  };
  await prepareLive(path, dependencies);
  return { root, store, path, plan, grant, options, dependencies, requests };
}

async function reviewDecision(f: Awaited<ReturnType<typeof fixture>>, decision: "approved" | "rejected" = "approved"): Promise<string> {
  const review = (await liveStatus(f.options.campaign)).state.review!;
  const path = join(f.root, `${decision}-decision.json`);
  await writeFile(path, JSON.stringify({
    $schema: SCHEMA_IDS.approval, schema_version: "1.0.0", decision_id: `dec-fixture-${decision}`, request_id: `req-fixture-${decision}`,
    action: "apply_optimization_candidate", scope: { kind: "proposal", value: review.scope, sha256: sha256(review.scope) }, decision,
    reviewer: { kind: "human", id: "fixture-human" }, decided_at: new Date(Date.now() - 10000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    rationale: "Synthetic review", evidence: ["repo://tests/live-loop.test.ts"], candidate_sha256: review.candidate,
  }));
  return path;
}

describe("live text supervisor with a synthetic transport", () => {
  it("stages an eligible generation with development-only BPE, then promotes, probes and rolls it back", async () => {
    const f = await fixture();
    const staged = await runLive(f.options, f.dependencies);
    expect(staged.phase).toBe("awaiting_review");
    expect(staged.active).toBe(sha256("weak strategy"));
    expect(staged.review).toMatchObject({ candidate: sha256("optimized strategy"), incumbent: sha256("weak strategy"), decision: null });
    expect(staged.exploration).toMatchObject({
      policy: { strategy: "development_first", max_parallelism: 1, max_rounds: 1 },
      rounds_completed: 1,
      nodes: [
        { id: "root", parent_id: null, generation: sha256("weak strategy") },
        { id: "node-0", parent_id: "root", generation: sha256("optimized strategy"), round: 1 },
      ],
    });
    expect(await runLive(f.options, f.dependencies)).toEqual(staged);
    expect(f.requests).toHaveLength(5);
    const decision = await reviewDecision(f);
    const state = await promoteLive({ ...f.options, approval: decision }, f.dependencies);
    expect(state.phase).toBe("complete");
    expect(state.active).toBe(sha256("optimized strategy"));
    expect(state.retained).toEqual([sha256("weak strategy"), sha256("optimized strategy")]);
    expect(f.requests).toHaveLength(6);
    const proposal = f.requests.find((request) => request.system.startsWith("Improve a bounded"))!;
    const proposalInput = JSON.parse(proposal.text);
    expect(proposalInput.development_cases).toEqual([{ case_id: "dev-task", input: "Development input", status: "contradicted" }]);
    expect(proposalInput.workspace).toEqual({
      belief: {
        generation: sha256("weak strategy"),
        development: [{ case_id: "dev-task", input_sha256: sha256("Development input"), response_sha256: expect.any(String), status: "contradicted" }],
      },
      progress: { phase: "baseline", candidates_evaluated: 0, candidate_limit: 1, candidates_remaining: 1 },
      experience: [{ generation: sha256("weak strategy"), development_score: 0 }],
    });
    expect(proposal.text).not.toContain("Qualification input");
    expect(proposal.text).not.toContain("Canary input");
    expect(JSON.stringify(f.requests)).not.toContain("private-oracle");
    expect(f.requests.every((request) => !("tools" in request))).toBe(true);
    const selected = await taskLive(f.options, "qual-task", "task-selected", f.dependencies);
    expect(selected.passed).toBe(true);
    expect(selected.generation).toBe(state.active);
    const rolled = await rollbackLive(f.options, f.dependencies);
    expect(rolled.active).toBe(sha256(f.plan.base_prompt));
    expect((await taskLive(f.options, "qual-task", "task-restored", f.dependencies)).passed).toBe(false);
    const status = await liveStatus(f.options.campaign);
    expect(status.requests_reserved).toBe(8);
    expect(status.workspace).toEqual({
      belief: {
        generation: sha256("weak strategy"),
        development: [{ case_id: "dev-task", input_sha256: sha256("Development input"), response_sha256: expect.any(String), status: "contradicted" }],
      },
      progress: { phase: "rolled_back", candidates_evaluated: 1, candidate_limit: 1, candidates_remaining: 0 },
      experience: [
        { generation: sha256("weak strategy"), development_score: 0 },
        { generation: sha256("optimized strategy"), development_score: 1 },
      ],
    });
    expect(JSON.stringify(status.workspace)).not.toContain("Qualification input");
    expect(JSON.stringify(status.workspace)).not.toContain("Canary input");
    expect(JSON.stringify(status.workspace)).not.toContain("private-oracle");
  });

  it("reuses verified completed operations after a lost intermediate state without duplicate sends", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    // Simulate loss after receipt publication but before the first state transition.
    for (let n = 1; n <= 3; n++) await rm(join(f.store, `state-${String(n).padStart(4, "0")}.json`));
    await runLive(f.options, f.dependencies);
    expect(f.requests).toHaveLength(5);
    await rm(join(f.store, "current.json"));
    await runLive(f.options, f.dependencies);
    expect((await liveStatus(f.options.campaign)).state.phase).toBe("awaiting_review");
    expect(f.requests).toHaveLength(5);
  });

  it("resumes an interrupted pre-discovery-tree campaign with its original linear semantics", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const legacy = JSON.parse(await readFile(join(f.store, "state-0001.json"), "utf8"));
    delete legacy.exploration;
    await writeFile(join(f.store, "state-0001.json"), JSON.stringify(legacy));
    await rm(join(f.store, "state-0002.json"));
    await rm(join(f.store, "state-0003.json"));
    await writeFile(join(f.store, "current.json"), JSON.stringify({ sequence: 1, state_sha256: sha256(canonicalJson(legacy)), generation: legacy.active }));
    const resumed = await runLive(f.options, f.dependencies);
    expect(resumed.phase).toBe("awaiting_review");
    expect(resumed.exploration).toBeUndefined();
    expect(f.requests).toHaveLength(5);
    await expect(dreamLive([f.options.campaign])).rejects.toMatchObject({ code: "LIVE_DREAM_UNAVAILABLE" });
  });

  it("retains the incumbent when qualification does not improve", async () => {
    const f = await fixture();
    const original = f.dependencies.driver;
    f.dependencies.driver = async (request) => request.text === "Qualification input" ? { text: '{"answer":"wrong"}', usage: null } : original(request);
    const state = await runLive(f.options, f.dependencies);
    expect(state.phase).toBe("complete");
    expect(state.active).toBe(sha256(f.plan.base_prompt));
    expect(state.retained).toHaveLength(1);
  });

  it("automatically compensates a failed canary and does not leave the candidate active", async () => {
    const f = await fixture();
    const original = f.dependencies.driver;
    f.dependencies.driver = async (request) => request.text === "Canary input" ? { text: '{"answer":"wrong"}', usage: null } : original(request);
    await runLive(f.options, f.dependencies);
    const state = await promoteLive({ ...f.options, approval: await reviewDecision(f) }, f.dependencies);
    expect(state.phase).toBe("rolled_back");
    expect(state.last_error).toBe("LIVE_CANARY_REGRESSION");
    expect(state.active).toBe(sha256(f.plan.base_prompt));
  });

  it("requires an exact human decision before promotion and records a rejection without changing the incumbent", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const approval = await reviewDecision(f);
    const invalid = JSON.parse(await readFile(approval, "utf8"));
    invalid.scope.value = "live-promotion-v1:wrong";
    invalid.scope.sha256 = sha256(invalid.scope.value);
    await writeFile(approval, JSON.stringify(invalid));
    await expect(promoteLive({ ...f.options, approval }, f.dependencies)).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect((await liveStatus(f.options.campaign)).state).toMatchObject({ phase: "awaiting_review", active: sha256(f.plan.base_prompt) });

    const rejection = await reviewDecision(f, "rejected");
    const rejected = await rejectLive(f.options.campaign, rejection);
    expect(rejected).toMatchObject({ phase: "rejected", active: sha256(f.plan.base_prompt), last_error: "LIVE_REVIEW_REJECTED" });
    expect(rejected.review?.decision).toMatchObject({ outcome: "rejected", decision_id: "dec-fixture-rejected" });
    await expect(promoteLive({ ...f.options, approval: rejection }, f.dependencies)).rejects.toMatchObject({ code: "LIVE_REVIEW_NOT_PENDING" });
  });

  it("does not record a decision or fail the campaign when activation authority is unavailable", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const approval = await reviewDecision(f);
    const originalRuntime = f.dependencies.runtimeIdentity;
    f.dependencies.runtimeIdentity = async () => "e".repeat(64);
    await expect(promoteLive({ ...f.options, approval }, f.dependencies)).rejects.toMatchObject({ code: "LIVE_RUNTIME_DRIFT" });
    expect((await liveStatus(f.options.campaign)).state).toMatchObject({ phase: "awaiting_review", review: { decision: null } });
    f.dependencies.runtimeIdentity = originalRuntime;
    expect((await promoteLive({ ...f.options, approval }, f.dependencies)).phase).toBe("complete");
  });

  it("leaves an interrupted probe pointer untouched until authorized promotion resumes it", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const approvalPath = await reviewDecision(f);
    const awaiting = JSON.parse(await readFile(join(f.store, "state-0003.json"), "utf8"));
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    const approvalSha256 = sha256(canonicalJson(approval));
    const decision = {
      $schema: SCHEMA_IDS.liveReview, schema_version: "1.0.0", kind: "decision", request_sha256: awaiting.review.request_sha256,
      approval_sha256: approvalSha256, decision_id: approval.decision_id, outcome: "approved", reviewer: approval.reviewer.id,
    };
    await writeFile(join(f.store, `reviews/${awaiting.review.request_sha256}.${approvalSha256}.decision.json`), JSON.stringify(decision));
    const probe = {
      ...awaiting,
      sequence: 4,
      previous_sha256: sha256(canonicalJson(awaiting)),
      phase: "probe",
      active: awaiting.review.candidate,
      review: { ...awaiting.review, decision: { approval_sha256: approvalSha256, decision_id: approval.decision_id, outcome: "approved" } },
    };
    await writeFile(join(f.store, "state-0004.json"), JSON.stringify(probe));
    const before = JSON.parse(await readFile(join(f.store, "current.json"), "utf8"));
    expect((await runLive(f.options, f.dependencies)).phase).toBe("probe");
    expect(JSON.parse(await readFile(join(f.store, "current.json"), "utf8"))).toEqual(before);
    expect((await liveStatus(f.options.campaign)).actual_retained).toBe(sha256("weak strategy"));
    expect((await promoteLive({ ...f.options, approval: approvalPath }, f.dependencies)).phase).toBe("complete");
  });

  it("finishes a review-less pre-HITL probe under its legacy campaign grant", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const awaiting = JSON.parse(await readFile(join(f.store, "state-0003.json"), "utf8"));
    const probe = { ...awaiting, sequence: 4, previous_sha256: sha256(canonicalJson(awaiting)), phase: "probe", active: awaiting.review.candidate };
    delete probe.review;
    await writeFile(join(f.store, "state-0004.json"), JSON.stringify(probe));
    const completed = await runLive(f.options, f.dependencies);
    expect(completed).toMatchObject({ phase: "complete", active: sha256("optimized strategy") });
    expect(f.requests).toHaveLength(6);
  });

  it("serves only sanitized review evidence over loopback and exports no decision", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const dashboard = await serveLiveReviewDashboard(f.options.campaign);
    try {
      expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await fetch(dashboard.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("optimized strategy");
      expect(html).not.toContain("private-oracle");
      expect(html).not.toContain("Qualification input");
      expect(html).not.toContain("Canary input");
      const request = await fetch(new URL("review-request.json", dashboard.url));
      expect(request.status).toBe(200);
      expect(await request.json()).toMatchObject({ kind: "request", candidate: sha256("optimized strategy") });
      expect((await fetch(dashboard.url, { method: "POST" })).status).toBe(405);
      const review = await liveReview(f.options.campaign);
      expect(review.review?.candidate).toMatchObject({ id: sha256("optimized strategy"), prompt: "optimized strategy" });
    } finally {
      await dashboard.close();
    }
  });

  it("dreams against recorded prefix-only discovery trees without new native calls", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const before = f.requests.length;
    const dreamed = await dreamLive([f.options.campaign]);
    roots.push(join(resolve(".dal/live/dreams"), `${sha256(canonicalJson(dreamed.sources))}.json`));
    expect(dreamed.kind).toBe("replay");
    expect(dreamed.sources).toHaveLength(1);
    expect(dreamed.policies.map((entry) => entry.policy.strategy).sort()).toEqual(["breadth_first", "development_first"]);
    expect(f.requests).toHaveLength(before);

    const tree: LiveDiscoveryNode[] = [
      { id: "root", parent_id: null, generation: "0".repeat(64), evaluation_sha256: "1".repeat(64), development_score: 0, qualification_score: 0, round: 0 },
      { id: "node-0", parent_id: "root", generation: "2".repeat(64), evaluation_sha256: "3".repeat(64), development_score: 1, qualification_score: 0.5, round: 1 },
      { id: "node-1", parent_id: "node-0", generation: "4".repeat(64), evaluation_sha256: "5".repeat(64), development_score: 1, qualification_score: 1, round: 2 },
    ];
    expect(replayDiscoveryTree(tree, { strategy: "breadth_first", max_parallelism: 1, max_rounds: 2 })).toMatchObject({ quality: 0.5, work: 1, rounds: 1 });
    expect(replayDiscoveryTree(tree, { strategy: "development_first", max_parallelism: 1, max_rounds: 2 })).toMatchObject({ quality: 1, work: 2, rounds: 2 });
  });

  it("replays only compatible campaign worlds and rejects a policy-trace rewrite", async () => {
    const first = await fixture({ candidates: 3, explorationPolicy: { strategy: "breadth_first", max_parallelism: 2, max_rounds: 2 } });
    const second = await fixture({ candidates: 3, explorationPolicy: { strategy: "breadth_first", max_parallelism: 2, max_rounds: 2 } });
    await runLive(first.options, first.dependencies);
    await runLive(second.options, second.dependencies);
    const dreamed = await dreamLive([first.options.campaign, second.options.campaign]);
    roots.push(join(resolve(".dal/live/dreams"), `${sha256(canonicalJson(dreamed.sources))}.json`));
    expect(dreamed.sources).toHaveLength(2);
    expect(dreamed.compatibility_sha256).toMatch(/^[a-f0-9]{64}$/);
    const state = JSON.parse(await readFile(join(first.store, "state-0004.json"), "utf8"));
    state.exploration.nodes[3].parent_id = "root";
    await writeFile(join(first.store, "state-0004.json"), JSON.stringify(state));
    await expect(liveStatus(first.options.campaign)).rejects.toMatchObject({ code: "LIVE_DISCOVERY_DRIFT" });
  });

  it("keeps an online breadth-first policy fixed while it opens and refines branches", async () => {
    const f = await fixture({ candidates: 3, explorationPolicy: { strategy: "breadth_first", max_parallelism: 2, max_rounds: 2 } });
    const state = await runLive(f.options, f.dependencies);
    expect(state.phase).toBe("awaiting_review");
    expect(state.exploration).toMatchObject({
      policy: { strategy: "breadth_first", max_parallelism: 2, max_rounds: 2 },
      rounds_completed: 2,
      nodes: [
        { id: "root", parent_id: null },
        { id: "node-0", parent_id: "root", round: 1 },
        { id: "node-1", parent_id: "root", round: 2 },
        { id: "node-2", parent_id: "node-0", round: 2 },
      ],
    });
    expect(f.requests).toHaveLength(11);
  });

  it.each(["expiry", "scope", "revocation", "runtime", "mount"])("denies %s before transport", async (kind) => {
    const f = await fixture();
    if (kind === "expiry") f.grant.expires_at = new Date(Date.now() - 1).toISOString();
    if (kind === "scope") f.grant.plan_sha256 = "e".repeat(64);
    await writeFile(f.options.grant, JSON.stringify(f.grant));
    if (kind === "revocation") await revokeLive(f.options.campaign);
    if (kind === "runtime") f.dependencies.runtimeIdentity = async () => "e".repeat(64);
    if (kind === "mount") {
      const mount = JSON.parse(await readFile(f.options.mountApproval, "utf8"));
      mount.decision = "rejected";
      await writeFile(f.options.mountApproval, JSON.stringify(mount));
    }
    await expect(runLive(f.options, f.dependencies)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });

  it("restores the prior generation if authority is revoked while the final canary is in flight", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    const decision = await reviewDecision(f);
    const original = f.dependencies.driver;
    f.dependencies.driver = async (request) => {
      if (request.text === "Canary input") await revokeLive(f.options.campaign);
      return original(request);
    };
    await expect(promoteLive({ ...f.options, approval: decision }, f.dependencies)).rejects.toMatchObject({ code: "LIVE_GRANT_REVOKED" });
    const status = await liveStatus(f.options.campaign);
    expect(status.state.phase).toBe("failed");
    expect(status.state.active).toBe(sha256(f.plan.base_prompt));
    expect(status.state.retained).toEqual([sha256(f.plan.base_prompt)]);
    expect(status.requests_reserved).toBe(6);
  });

  it("retains failed allocations, refuses pending effects and never retries a failed campaign", async () => {
    const f = await fixture();
    f.dependencies.driver = vi.fn(async () => { throw new Error("private failure text must not persist"); });
    await expect(runLive(f.options, f.dependencies)).rejects.toMatchObject({ code: "LIVE_RESPONSE_INVALID" });
    const status = await liveStatus(f.options.campaign);
    expect(status.requests_reserved).toBe(1);
    expect(status.state.phase).toBe("failed");
    const receiptPath = join(f.store, "operations/baseline-dev-task.receipt.json");
    expect(await readFile(receiptPath, "utf8")).not.toContain("private failure text");
    // Restore only the initial state and remove the terminal receipt: no retry.
    await rm(join(f.store, "state-0001.json"));
    await rm(receiptPath);
    await expect(runLive(f.options, f.dependencies)).rejects.toMatchObject({ code: "LIVE_UNKNOWN_EFFECT" });
    expect(f.dependencies.driver).toHaveBeenCalledTimes(1);
  });

  it("excludes concurrent supervisors and refuses recovery while the owner is alive", async () => {
    const f = await fixture();
    await writeFile(join(f.store, "lease.json"), JSON.stringify({ pid: process.pid }));
    await expect(runLive(f.options, f.dependencies)).rejects.toMatchObject({ code: "LIVE_BUSY" });
    await expect(recoverLive(f.options.campaign)).rejects.toMatchObject({ code: "LIVE_OWNER_ALIVE" });
    expect(f.requests).toHaveLength(0);
  });

  it("rejects pointer drift, exhausted allocations and receipts rebound to another request", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    await promoteLive({ ...f.options, approval: await reviewDecision(f) }, f.dependencies);
    const current = JSON.parse(await readFile(join(f.store, "current.json"), "utf8"));
    await writeFile(join(f.store, "current.json"), JSON.stringify({ ...current, generation: "0".repeat(64) }));
    await expect(taskLive(f.options, "qual-task", "task-drift", f.dependencies)).rejects.toMatchObject({ code: "LIVE_POINTER_DRIFT" });
    await writeFile(join(f.store, "current.json"), JSON.stringify(current));
    for (let index = 0; index < 3; index++) await taskLive(f.options, "qual-task", `task-extra-${index}`, f.dependencies);
    await expect(taskLive(f.options, "qual-task", "task-exhausted", f.dependencies)).rejects.toMatchObject({ code: "LIVE_BUDGET_EXHAUSTED" });
    expect((await liveStatus(f.options.campaign)).requests_reserved).toBe(9);
  });

  it("verifies the explicit campaign authority extension through the approval CLI", async () => {
    const f = await fixture();
    const output: string[] = [];
    const code = await runCli(["approval", "verify", f.options.grant, "--plan", f.path, "--action", "send_data_externally", "--scope", planDigest(f.plan)], { stdout: (text) => output.push(text), stderr: (text) => output.push(text) });
    expect(code).toBe(0);
    expect(JSON.parse(output.join("")).action).toBe("send_text");
  });
});
