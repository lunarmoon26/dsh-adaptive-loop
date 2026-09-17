import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planDigest, nativeMountScope } from "../src/live/authority.js";
import { liveStatus, prepareLive, recoverLive, revokeLive, rollbackLive, runLive, taskLive, type LiveDependencies } from "../src/live/loop.js";
import { sha256 } from "../src/json.js";
import { SCHEMA_IDS } from "../src/schema.js";
import type { CampaignGrant, LivePlan, TextRequest } from "../src/live/types.js";
import { runCli } from "../src/cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  await mkdir(resolve(".dal/check"), { recursive: true });
  const root = await mkdtemp(resolve(".dal/check/live-test-"));
  const campaign = `live-${randomUUID()}`;
  const store = resolve(".dal/live", campaign);
  roots.push(root, store);
  const plan: LivePlan = {
    $schema: SCHEMA_IDS.livePlan, schema_version: "1.0.0", campaign_id: campaign, workspace: await realpath(process.cwd()), runtime_sha256: "c".repeat(64), credential_store: "/fixture/native-store.yaml", model: "synthetic",
    goal: "Improve completion", response_contract: "Return one object with answer as a string", base_prompt: "weak strategy",
    cases: [
      { id: "dev-task", role: "development", input: "Development input", expected: { answer: "private-oracle" } },
      { id: "qual-task", role: "qualification", input: "Qualification input", expected: { answer: "private-oracle" } },
      { id: "canary-task", role: "canary", input: "Canary input", expected: { answer: "private-oracle" } },
    ],
    limits: { candidates: 1, requests: 9, timeout_ms: 1000, output_tokens: 128, output_bytes: 4096, prompt_bytes: 2048 }, minimum_gain: 0.5,
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

describe("live text supervisor with a synthetic transport", () => {
  it("automatically generates, evaluates, activates, probes and consumes the active generation, then rolls back", async () => {
    const f = await fixture();
    const state = await runLive(f.options, f.dependencies);
    expect(state.phase).toBe("complete");
    expect(state.active).toBe(sha256("optimized strategy"));
    expect(state.retained).toEqual([sha256("weak strategy"), sha256("optimized strategy")]);
    expect(f.requests).toHaveLength(6);
    const proposal = f.requests.find((request) => request.system.startsWith("Improve a bounded"))!;
    expect(proposal.text).toContain("Development input");
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
    expect((await liveStatus(f.options.campaign)).requests_reserved).toBe(8);
  });

  it("reuses verified completed operations after a lost intermediate state without duplicate sends", async () => {
    const f = await fixture();
    await runLive(f.options, f.dependencies);
    // Simulate loss after receipt publication but before the first state transition.
    for (let n = 1; n <= 4; n++) await rm(join(f.store, `state-${String(n).padStart(4, "0")}.json`));
    await runLive(f.options, f.dependencies);
    expect(f.requests).toHaveLength(6);
    await rm(join(f.store, "current.json"));
    await runLive(f.options, f.dependencies);
    expect((await liveStatus(f.options.campaign)).state.phase).toBe("complete");
    expect(f.requests).toHaveLength(6);
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
    const state = await runLive(f.options, f.dependencies);
    expect(state.phase).toBe("rolled_back");
    expect(state.last_error).toBe("LIVE_CANARY_REGRESSION");
    expect(state.active).toBe(sha256(f.plan.base_prompt));
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
    const original = f.dependencies.driver;
    f.dependencies.driver = async (request) => {
      if (request.text === "Canary input") await revokeLive(f.options.campaign);
      return original(request);
    };
    await expect(runLive(f.options, f.dependencies)).rejects.toMatchObject({ code: "LIVE_GRANT_REVOKED" });
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
