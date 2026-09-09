import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256 } from "../../src/json.js";
import { gatewayPolicyTemplate, plannedRunId, transmissionManifest, type TransmissionManifest } from "./run-e2e.js";

const root = resolve(import.meta.dirname, "../..");
const task = "task-001-refund.json";
const providers = [
  { provider: "openai", model: "gpt-5.6-terra", cap: 6_000_000 },
  { provider: "anthropic", model: "claude-sonnet-5", cap: 5_000_000 },
] as const;

export interface CampaignOptions { image: string; campaign: string; output: string }
export interface PendingApprovalRequest {
  format: "approval-request-v1";
  request_id: string;
  decision_id: string;
  action: "send_data_externally";
  scope: { kind: "data_transfer"; value: string; sha256: string };
  status: "pending";
  reviewer: null;
  authorized: false;
}
export interface PreparedCampaign {
  format: "paid-campaign-preflight-v1";
  campaign_id: string;
  image: string;
  planner_sha256: string;
  status: "pending-exact-paid-approval";
  phase1: Array<{
    provider: string; model: string; provider_cap_microusd: number;
    batch: string; run_id: string; attempts: 1; task: string;
    manifest: string; manifest_sha256: string; policy: string; approval_request: string;
    prepare_argv: string[];
  }>;
  phase2: {
    status: "blocked-on-sanitized-phase1-evidence";
    max_proposal_requests_per_provider: 1;
    approval: "exact-metered-proposal-manifest-required";
    budget: "same-campaign-provider-cap-shared-handoff-required";
    candidate: null;
    improvement_claim: false;
  };
}

// Internal test seam only; the CLI never accepts a resolver or untrusted manifest.
type ManifestResolver = (args: Map<string, string>) => Promise<TransmissionManifest>;

export function parseCampaignArguments(argv: string[]): CampaignOptions & { verify: boolean } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!["--image", "--campaign", "--output", "--verify"].includes(key) || args.has(key) || !value || value.startsWith("--")) throw new Error("Invalid, duplicate or missing preflight option");
    args.set(key, value);
  }
  if (!args.has("--image") || !args.has("--campaign") || args.has("--output") === args.has("--verify")) throw new Error("Require --image, --campaign and exactly one of --output or --verify");
  return { image: args.get("--image")!, campaign: args.get("--campaign")!, output: args.get("--output") ?? args.get("--verify")!, verify: args.has("--verify") };
}

async function outputPath(options: CampaignOptions, verify: boolean): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.campaign)) throw new Error("Invalid campaign identifier");
  if (!/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/:\-]*(?:@sha256:[a-f0-9]{64}|:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}))$/.test(options.image) || options.image.endsWith(":latest")) throw new Error("Require an exact image tag or SHA-256 digest, not latest");
  const output = resolve(root, options.output);
  if ((isAbsolute(options.output) ? output : relative(root, output)) !== options.output) throw new Error("Output must be canonical");
  const check = join(root, ".dal/check");
  if (!output.startsWith(`${check}/`) || await realpath(dirname(output)) !== dirname(output)) throw new Error("Output parent must be an existing real directory below .dal/check");
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (verify ? !existing?.isDirectory() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 : existing !== null) throw new Error(verify ? "Require a private real campaign directory" : "Output already exists");
  return output;
}

async function campaignFiles(options: CampaignOptions, output: string, resolver: ManifestResolver): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  const campaign: PreparedCampaign = {
    format: "paid-campaign-preflight-v1", campaign_id: options.campaign, image: options.image,
    planner_sha256: sha256(await readFile(join(root, "benchmarks/tau-style-workflow/prepare-paid-campaign.ts"), "utf8")),
    status: "pending-exact-paid-approval", phase1: [],
    phase2: { status: "blocked-on-sanitized-phase1-evidence", max_proposal_requests_per_provider: 1,
      approval: "exact-metered-proposal-manifest-required", budget: "same-campaign-provider-cap-shared-handoff-required", candidate: null, improvement_claim: false },
  };
  let shared: string | undefined;
  for (const { provider, model, cap } of providers) {
    const identity = sha256(canonicalJson({ campaign: options.campaign, provider })).slice(0, 32);
    const batch = `baseline-${identity}`;
    const approvalId = `dec-paid-${identity}`;
    const args = new Map<string, string>([
      ["mode", "live"], ["campaign", options.campaign], ["batch", batch], ["provider", provider], ["model", model],
      ["provider-cap-microusd", String(cap)], ["approval-id", approvalId], ["image", options.image],
      ["tasks", task], ["attempts", "1"], ["prepare", "true"],
      ["manifest", `${output}-${provider}-runner-manifest.json`],
    ]);
    const runId = plannedRunId(args, task, 1);
    const policy = gatewayPolicyTemplate(args, runId);
    const manifest = await resolver(args);
    if (manifest.provider !== provider || manifest.model !== model || manifest.campaign_id !== options.campaign || manifest.mode !== "live" || manifest.attempts_per_task !== 1 ||
        !/^[a-f0-9]{64}$/.test(manifest.container_image_sha256 ?? "") ||
        manifest.evaluator_tasks.length !== 1 || manifest.evaluator_tasks[0]?.task_id !== task ||
        canonicalJson(manifest.gateway_policies) !== canonicalJson([{ task_id: task, attempt: 1, policy }])) throw new Error("Manifest does not match finite campaign scope");
    const common = canonicalJson(Object.fromEntries(["container_image_sha256", "policy_sha256", "skill_sha256", "workflow_tools_sha256", "agent_tasks", "evaluator_tasks", "prompts", "driver_sources", "benchmark_context_sha256", "gateway_ledger_root"].map(key => {
      if (manifest[key] === undefined) throw new Error(`Incomplete manifest: ${key}`);
      return [key, manifest[key]];
    })));
    if (shared !== undefined && shared !== common) throw new Error("Provider manifests must share image, task, policy, skill, prompt, source and ledger identities");
    shared = common;
    const manifestName = `${provider}.manifest.json`;
    const digest = sha256(canonicalJson(manifest));
    const request: PendingApprovalRequest = {
      format: "approval-request-v1", request_id: `req-paid-${identity}`, decision_id: approvalId,
      action: "send_data_externally", scope: { kind: "data_transfer", value: digest, sha256: sha256(digest) },
      status: "pending", reviewer: null, authorized: false,
    };
    files[manifestName] = manifest;
    files[`${provider}.policy.json`] = policy;
    files[`${provider}.approval-request.json`] = request;
    campaign.phase1.push({ provider, model, provider_cap_microusd: cap, batch, run_id: runId, attempts: 1, task,
      manifest: manifestName, manifest_sha256: digest, policy: `${provider}.policy.json`, approval_request: `${provider}.approval-request.json`,
      prepare_argv: ["pnpm", "exec", "tsx", "benchmarks/tau-style-workflow/run-e2e.ts", ...[...args].flatMap(([key, value]) => [`--${key}`, value])] });
  }
  files["campaign.json"] = campaign;
  return files;
}

export async function preparePaidCampaign(options: CampaignOptions, resolver: ManifestResolver = transmissionManifest): Promise<PreparedCampaign> {
  const output = await outputPath(options, false);
  const files = await campaignFiles(options, output, resolver);
  await mkdir(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) await writeFile(join(output, name), `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
  return files["campaign.json"] as PreparedCampaign;
}

export async function verifyPreparedCampaign(options: CampaignOptions, resolver: ManifestResolver = transmissionManifest): Promise<PreparedCampaign> {
  const output = await outputPath(options, true);
  const expected = await campaignFiles(options, output, resolver);
  if (canonicalJson((await readdir(output)).sort()) !== canonicalJson(Object.keys(expected).sort())) throw new Error("Campaign file inventory drift");
  for (const [name, value] of Object.entries(expected)) {
    const path = join(output, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error("Campaign files must be private regular files");
    if (canonicalJson(JSON.parse(await readFile(path, "utf8"))) !== canonicalJson(value)) throw new Error(`Campaign drift: ${name}`);
  }
  return expected["campaign.json"] as PreparedCampaign;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCampaignArguments(process.argv.slice(2));
  const campaign = await (options.verify ? verifyPreparedCampaign(options) : preparePaidCampaign(options));
  console.log(JSON.stringify({ campaign_id: campaign.campaign_id, status: campaign.status, verified: options.verify, path: resolve(root, options.output) }));
}
