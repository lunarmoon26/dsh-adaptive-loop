import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/json.js";
import { parseCampaignArguments, preparePaidCampaign, verifyPreparedCampaign, type CampaignOptions } from "../benchmarks/tau-style-workflow/prepare-paid-campaign.js";
import { gatewayPolicyTemplate, plannedRunId, type TransmissionManifest } from "../benchmarks/tau-style-workflow/run-e2e.js";

vi.mock("node:child_process", () => ({ spawnSync: () => { throw new Error("No subprocess allowed in unit tests"); } }));
vi.mock("../src/approval.js", () => ({ verifyApprovalFile: () => { throw new Error("No approval execution allowed in preflight"); } }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) => {
    if (/(?:^|\/)\.env(?:\.|$)|credentials/i.test(String(args[0]))) throw new Error("Forbidden credential file read");
    return fs.readFile(...args);
  } };
});
const directories: string[] = [];
const digest = "a".repeat(64);
const task = "task-001-refund.json";
async function options(): Promise<CampaignOptions> {
  await mkdir(resolve(".dal/check"), { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(resolve(".dal/check/paid-preflight-test-"));
  directories.push(parent);
  return { campaign: "test-paid-campaign", image: "dal-derived:test-v1", output: join(parent, "campaign") };
}
async function manifest(args: Map<string, string>): Promise<TransmissionManifest> {
  return {
    mode: args.get("mode"), campaign_id: args.get("campaign"), provider: args.get("provider"), model: args.get("model"),
    attempts_per_task: 1, container_image_sha256: digest, benchmark_context_sha256: digest, generation: null,
    policy_sha256: digest, skill_sha256: digest, workflow_tools_sha256: digest,
    agent_tasks: [{ task_id: task, sha256: digest }], evaluator_tasks: [{ task_id: task, sha256: digest }],
    prompts: [{ task_id: task, prompt: "synthetic test prompt" }], driver_sources: { gateway_sha256: digest },
    gateway_ledger_root: resolve(".dal/check/spend"),
    gateway_policies: [{ task_id: task, attempt: 1, policy: gatewayPolicyTemplate(args, plannedRunId(args, task, 1)) }],
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("paid campaign preflight", () => {
  it("selects an existing repository task fixture and accepts its hyphenated filename in runner policies", async () => {
    const opts = await options();
    const prepared = await preparePaidCampaign(opts, async args => {
      const selected = args.get("tasks")!;
      const fixturePath = new URL(`../benchmarks/tau-style-workflow/tasks/${selected}`, import.meta.url);
      expect((await stat(fixturePath)).isFile()).toBe(true);
      const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
      expect(`${fixture.task_id}.json`).toBe(selected);
      const runId = plannedRunId(args, selected, 1);
      expect(runId).toMatch(/^run-e2e-[a-f0-9]{48}$/);
      expect(gatewayPolicyTemplate(args, runId).run_id).toBe(runId);
      return manifest(args);
    });
    for (const phase of prepared.phase1) {
      expect(phase.task).toBe("task-001-refund.json");
      expect(phase.prepare_argv[phase.prepare_argv.indexOf("--tasks") + 1]).toBe(phase.task);
    }
  });

  it("prepares exactly two finite, cap-bound, pending-only baselines and verifies canonical artifacts", async () => {
    const opts = await options();
    const calls: Map<string, string>[] = [];
    const prepared = await preparePaidCampaign(opts, async args => { calls.push(args); return manifest(args); });
    expect(prepared.phase1.map(p => [p.provider, p.model, p.provider_cap_microusd, p.task, p.attempts])).toEqual([
      ["openai", "gpt-5.6-terra", 6_000_000, task, 1], ["anthropic", "claude-sonnet-5", 5_000_000, task, 1],
    ]);
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.get("mode")).toBe("live");
      expect(args.get("prepare")).toBe("true");
      expect(args.get("approval")).toBeUndefined();
      expect(args.get("image")).toBe(opts.image);
    }
    for (const phase of prepared.phase1) {
      const request = JSON.parse(await readFile(join(opts.output, phase.approval_request), "utf8"));
      expect(request).toMatchObject({ status: "pending", authorized: false, reviewer: null, scope: { value: phase.manifest_sha256, sha256: sha256(phase.manifest_sha256) } });
      expect(request.decision).toBeUndefined();
      const policy = JSON.parse(await readFile(join(opts.output, phase.policy), "utf8"));
      expect(policy).toMatchObject({ campaign_id: opts.campaign, budget_id: opts.campaign, approval_id: request.decision_id,
        provider_limit_microusd: phase.provider_cap_microusd, max_output_tokens: 1024, max_request_bytes: 65536,
        token_bound_profile: "json-bytes-times-two-plus-8192-v1" });
      expect((await stat(join(opts.output, phase.manifest))).mode & 0o777).toBe(0o600);
      expect(phase.prepare_argv).toContain("--manifest");
    }
    expect((await stat(opts.output)).mode & 0o777).toBe(0o700);
    expect(prepared.phase2).toMatchObject({ candidate: null, improvement_claim: false, approval: "exact-metered-proposal-manifest-required" });
    expect(await verifyPreparedCampaign(opts, manifest)).toEqual(prepared);
  });

  it.each(["model", "cap", "task", "image", "source", "prompt", "skill", "approval"])("rejects persisted %s drift", async field => {
    const opts = await options();
    await preparePaidCampaign(opts, manifest);
    const path = join(opts.output, "openai.manifest.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (field === "model") value.model = "other";
    if (field === "cap") value.gateway_policies[0].policy.provider_limit_microusd++;
    if (field === "task") value.evaluator_tasks[0].task_id = "other.json";
    if (field === "image") value.container_image_sha256 = "b".repeat(64);
    if (field === "source") value.driver_sources.gateway_sha256 = "b".repeat(64);
    if (field === "prompt") value.prompts[0].prompt = "changed";
    if (field === "skill") value.skill_sha256 = "b".repeat(64);
    if (field === "approval") value.gateway_policies[0].policy.approval_id = "dec-other";
    await writeFile(path, JSON.stringify(value));
    await expect(verifyPreparedCampaign(opts, manifest)).rejects.toThrow("drift");
  });

  it("re-resolves current image/source and rejects new input and common-context drift", async () => {
    const opts = await options();
    await preparePaidCampaign(opts, manifest);
    await expect(verifyPreparedCampaign({ ...opts, image: "dal-derived:changed" }, manifest)).rejects.toThrow("drift");
    await expect(verifyPreparedCampaign({ ...opts, campaign: "other-campaign" }, manifest)).rejects.toThrow("drift");
    await expect(verifyPreparedCampaign(opts, async args => ({ ...await manifest(args), container_image_sha256: "b".repeat(64) }))).rejects.toThrow("drift");
    await expect(verifyPreparedCampaign(opts, async args => ({ ...await manifest(args), driver_sources: { changed: digest } }))).rejects.toThrow("drift");
    await expect(verifyPreparedCampaign(opts, async args => ({ ...await manifest(args), skill_sha256: args.get("provider") === "openai" ? digest : "b".repeat(64) }))).rejects.toThrow("must share");
  });

  it("rejects resolver scope changes before output creation", async () => {
    const opts = await options();
    for (const patch of [{ model: "other" }, { attempts_per_task: 2 }, { evaluator_tasks: [] }, { gateway_policies: [] }, { container_image_sha256: null }]) {
      await expect(preparePaidCampaign(opts, async args => ({ ...await manifest(args), ...patch }))).rejects.toThrow("finite campaign scope");
    }
    await expect(stat(opts.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one concurrent writer and rejects planner identity drift", async () => {
    const opts = await options();
    const results = await Promise.allSettled([preparePaidCampaign(opts, manifest), preparePaidCampaign(opts, manifest)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await verifyPreparedCampaign(opts, manifest);
    const path = join(opts.output, "campaign.json");
    const campaign = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...campaign, planner_sha256: "b".repeat(64) }));
    await expect(verifyPreparedCampaign(opts, manifest)).rejects.toThrow("drift");
  });

  it("refuses existing, unsafe, missing-parent and symlink outputs before resolving manifests", async () => {
    const opts = await options();
    await preparePaidCampaign(opts, manifest);
    const resolver = vi.fn(manifest);
    for (const output of [opts.output, resolve("outside-paid-campaign"), `${opts.output}/../alias`, join(opts.output, "missing", "new")]) {
      await expect(preparePaidCampaign({ ...opts, output }, resolver)).rejects.toThrow();
    }
    const link = `${opts.output}-link`;
    await symlink(opts.output, link);
    await expect(preparePaidCampaign({ ...opts, output: join(link, "new") }, resolver)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("never reads provider credentials or image fallback, fetches, or spawns in injected planning", async () => {
    const opts = await options();
    const original = process.env;
    process.env = new Proxy(original, { get(target, key) {
      if (typeof key === "string" && (/API_KEY|TOKEN|SECRET|CREDENTIAL/.test(key) || key === "DAL_E2E_IMAGE")) throw new Error("Forbidden environment read");
      return Reflect.get(target, key);
    } });
    vi.stubGlobal("fetch", () => { throw new Error("No network"); });
    try {
      await preparePaidCampaign(opts, manifest);
      await verifyPreparedCampaign(opts, manifest);
    } finally { process.env = original; }
  });

  it("rejects approval-state and directory inventory tampering", async () => {
    const opts = await options();
    await preparePaidCampaign(opts, manifest);
    const path = join(opts.output, "openai.approval-request.json");
    const request = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...request, status: "approved", authorized: true }));
    await expect(verifyPreparedCampaign(opts, manifest)).rejects.toThrow("drift");
    await writeFile(join(opts.output, "extra.json"), "{}");
    await expect(verifyPreparedCampaign(opts, manifest)).rejects.toThrow("inventory");
  });

  it("accepts only explicit preparation or verification CLI options", async () => {
    const argv = ["--image", "dal:test", "--campaign", "paid-test", "--output", ".dal/check/new"];
    expect(parseCampaignArguments(argv)).toMatchObject({ verify: false, image: "dal:test" });
    expect(parseCampaignArguments([...argv.slice(0, 4), "--verify", ".dal/check/new"]).verify).toBe(true);
    for (const extra of [["--approve", "true"], ["--provider", "other"], ["--image", "other:tag"], ["--verify", "path"], ["--resolver", "path"], ["positional"]]) {
      expect(() => parseCampaignArguments([...argv, ...extra])).toThrow();
    }
    expect(() => parseCampaignArguments([])).toThrow();
    const opts = await options();
    for (const image of ["", "dal", "dal:latest", "dal:test --pull", "https://host/image"]) {
      await expect(preparePaidCampaign({ ...opts, image }, manifest)).rejects.toThrow("image");
    }
  });
});
