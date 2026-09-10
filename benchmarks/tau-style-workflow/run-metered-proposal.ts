import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyApprovalFile } from "../../src/approval.js";
import { gatewayReservation, GATEWAY_ROUTES, startGateway } from "../../src/e2e-model-gateway.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "../../src/json.js";
import { prepareProposePayload, proposeDraft } from "../../src/propose.js";
import { parseChatResponse, prepareChatRequest } from "../../src/propose-transport.js";
import { prepareSkillProposal, validateSkillProposalReply } from "../../src/skill-proposal.js";
import { evaluateOptimizerCandidate } from "../../src/optimizer-adapter.js";
import { gatewayLedgerRoot, gatewayPolicyTemplate, safeGatewayReceipt } from "./run-e2e.js";
import { assessDevelopmentBaseline } from "./skill-adaptation.js";
import { readSummary } from "./e2e-summary.js";
import { assertSchema, SCHEMA_IDS } from "../../src/schema.js";
import type { ClusterRecord } from "../../src/types.js";

const root = resolve(import.meta.dirname, "../..");
const allowed = ["mode", "campaign", "batch", "provider", "model", "provider-cap-microusd", "clusters", "runs", "output", "approval-id", "approval", "prepare", "verify", "manifest", "exchange", "candidate-out", "development-baseline"];

export function parseMeteredArguments(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !key || !allowed.includes(key) || args.has(key) || !value || value.startsWith("--")) throw new Error("Invalid metered proposal option");
    args.set(key, value);
  }
  return args;
}

// Resolve against this DAL checkout, never the launcher's cwd or a supplied ledger root.
async function inputInventory(directory: string, runs: boolean) {
  const path = resolve(root, directory);
  if (await realpath(path) !== path || /(^|\/)\.env(?:[./]|$)/.test(path)) throw new Error("Inputs must be real non-env directories");
  const ids = new Set<string>();
  const files: Array<{ name: string; sha256: string }> = [];
  for (const name of (await readdir(path)).filter(n => n.endsWith(".json")).sort()) {
    const file = join(path, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || name.startsWith(".env")) throw new Error("Inputs must be regular non-env JSON files");
    const raw = await readFile(file);
    if (runs) {
      const value = JSON.parse(raw.toString("utf8"));
      if (typeof value.run_id !== "string" || ids.has(value.run_id)) throw new Error("Run IDs must be unique for deterministic projection");
      ids.add(value.run_id);
    }
    files.push({ name, sha256: sha256(raw) });
  }
  return { path, files };
}

async function developmentBaseline(args: Map<string, string>, baseDigest: string, clusters: Awaited<ReturnType<typeof inputInventory>>, runs: Awaited<ReturnType<typeof inputInventory>> | null) {
  if (!args.get("development-baseline") || !runs) throw new Error("Live skill proposals require --development-baseline and --runs");
  const path = resolve(root, args.get("development-baseline")!);
  if (relative(root, path).startsWith("..") || /(^|\/)\.env(?:[./]|$)/.test(path) || await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Development baseline must be a real root-local non-env summary");
  const raw = await readFile(path);
  const summary = await readSummary(path);
  const report = await assessDevelopmentBaseline(path, root);
  if (!report.eligible) throw new Error("Development baseline is not eligible for a skill proposal");
  if (summary.model.provider !== args.get("provider") || summary.model.model !== args.get("model") || summary.candidate_sha256 !== baseDigest) throw new Error("Development baseline model or skill base mismatch");
  const attempts = new Map(summary.per_task.flatMap(task => task.attempts_detail).map(detail => [detail.run_id, detail]));
  const supplied = new Set<string>();
  for (const file of runs.files) {
    const runRaw = await readFile(join(runs.path, file.name));
    const run = JSON.parse(runRaw.toString("utf8")) as { run_id: string };
    const detail = attempts.get(run.run_id);
    if (!detail || sha256(runRaw) !== detail.run_record_sha256 || sha256(runRaw) !== file.sha256) throw new Error("Proposal runs must match development baseline attempts exactly");
    supplied.add(run.run_id);
  }
  if (supplied.size !== attempts.size) throw new Error("Proposal runs must match development baseline attempts exactly");
  for (const file of clusters.files) {
    const clusterRaw = await readFile(join(clusters.path, file.name));
    const cluster = JSON.parse(clusterRaw.toString("utf8")) as ClusterRecord;
    await assertSchema(SCHEMA_IDS.clusterRecord, cluster, "Development cluster");
    if (sha256(clusterRaw) !== file.sha256 || [...cluster.members, cluster.representative].some(member => !attempts.has(member.run_id) || !supplied.has(member.run_id))) throw new Error("Proposal clusters must contain only supplied development baseline runs");
  }
  // Keep scientific evidence local: bind references and bytes, never add it to the native payload.
  const evidencePaths = [...new Set(report.evidence.flatMap(entry => [entry.manifest_path,
    ...entry.attempts.flatMap(attempt => [attempt.receipt_path, attempt.run_record_path])]))].sort();
  const files = await Promise.all(evidencePaths.map(async name => ({ path: name, sha256: sha256(await readFile(resolve(root, name))) })));
  if (canonicalJson(summary) !== canonicalJson(JSON.parse(raw.toString("utf8"))) || sha256(await readFile(path)) !== sha256(raw)) throw new Error("Development baseline changed during assessment");
  return { path, sha256: sha256(raw), evidence: report.evidence, files };
}

export async function prepareMeteredProposal(args: Map<string, string>) {
  if ([...args.keys()].some(key => !allowed.includes(key))) throw new Error("Unknown metered proposal option");
  for (const flag of ["prepare", "verify"]) if (args.has(flag) && args.get(flag) !== "true") throw new Error(`--${flag} accepts only true`);
  if (args.has("prepare") && args.has("verify")) throw new Error("Prepare and verify are exclusive");
  if (args.has("exchange") !== args.has("candidate-out")) throw new Error("Require both --exchange and --candidate-out");
  if (args.has("development-baseline") && (!args.has("exchange") || args.get("mode") !== "live")) throw new Error("--development-baseline is only for live skill proposals");
  if (args.has("exchange") && args.get("mode") === "live" && (!args.has("development-baseline") || !args.has("runs"))) throw new Error("Live skill proposals require --development-baseline and --runs");
  if (args.has("exchange") && !/^\.dal\/candidates\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(args.get("candidate-out")!)) throw new Error("Candidate output must be a direct .dal/candidates Markdown file");
  if (args.get("campaign")?.startsWith("rehearsal-")) throw new Error("Campaign uses the reserved rehearsal namespace");
  const batch = args.get("batch");
  if (!batch || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(batch)) throw new Error("Require a safe batch identifier");
  if (!args.get("clusters")) throw new Error("Require --clusters");
  const runId = `run-propose-${sha256(canonicalJson({ campaign: args.get("campaign") ?? "", batch, provider: args.get("provider") ?? "", mode: args.get("mode") ?? "" })).slice(0, 48)}`;
  const policy = gatewayPolicyTemplate(args, runId);
  const ledgerRoot = await gatewayLedgerRoot(new Map());
  const clusters = await inputInventory(args.get("clusters")!, false);
  const runs = args.has("runs") ? await inputInventory(args.get("runs")!, true) : null;
  const summaries = await prepareProposePayload({ clustersDir: clusters.path, ...(runs ? { runsDir: runs.path } : {}) });
  const skill = args.has("exchange") ? await prepareSkillProposal(root, args.get("exchange")!, summaries.payload) : null;
  const baseline = skill && args.get("mode") === "live" ? await developmentBaseline(args, skill.inputs.base.sha256, clusters, runs) : null;
  const inputs = { clusters, runs, ...(skill ? { skill: skill.inputs } : {}), ...(baseline ? { development_baseline: baseline } : {}) };
  const prepared = skill ?? summaries;
  // The legacy builder requires a declared allocation. Only its body is used;
  // this placeholder is never persisted, approved, reserved, or sent.
  const nativeBody = prepareChatRequest(prepared.payload, policy, {
    budget_id: policy.budget_id, provider_limit_microusd: policy.provider_limit_microusd, reservation_microusd: 1,
  }).request.body;
  if (policy.provider === "openai") nativeBody.max_output_tokens = 1024;
  else nativeBody.max_tokens = 1024;
  const requestBytes = Buffer.byteLength(canonicalJson(nativeBody));
  const upper = gatewayReservation(policy, requestBytes);
  if (upper > policy.provider_limit_microusd) throw new Error("Proposal upper bound exceeds provider cap");
  const sourcePaths = [
    "benchmarks/tau-style-workflow/run-metered-proposal.ts", "benchmarks/tau-style-workflow/run-e2e.ts",
    "src/e2e-model-gateway.ts", "src/propose.ts", "src/propose-transport.ts", "src/proposal-budget.ts",
    "src/schema.ts", "src/json.ts", "src/privacy.ts", "src/approval.ts", "src/types.ts", "src/errors.ts",
    ...(skill ? ["src/skill-proposal.ts", "src/optimizer.ts", "src/optimizer-adapter.ts"] : []),
    ...(baseline ? ["benchmarks/tau-style-workflow/skill-adaptation.ts", "benchmarks/tau-style-workflow/e2e-summary.ts", "src/execution-receipt.ts", "src/runs.ts"] : []),
    ...(await readdir(join(root, "schemas"))).filter(n => n.endsWith(".json")).sort().map(n => `schemas/${n}`),
  ];
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) })));
  const repeatedSummaries = await prepareProposePayload({ clustersDir: clusters.path, ...(runs ? { runsDir: runs.path } : {}) });
  const repeatedSkill = skill ? await prepareSkillProposal(root, args.get("exchange")!, repeatedSummaries.payload) : null;
  const repeatedBaseline = baseline ? await developmentBaseline(args, repeatedSkill!.inputs.base.sha256, clusters, runs) : null;
  const after = { clusters: await inputInventory(clusters.path, false), runs: runs ? await inputInventory(runs.path, true) : null, ...(repeatedSkill ? { skill: repeatedSkill.inputs } : {}), ...(repeatedBaseline ? { development_baseline: repeatedBaseline } : {}) };
  const repeated = repeatedSkill ?? repeatedSummaries;
  if (canonicalJson(inputs) !== canonicalJson(after) || prepared.json !== repeated.json) throw new Error("Input projection drift");
  const manifest = {
    format: "metered-proposal-v1", mode: args.get("mode") as "live" | "rehearsal", campaign_id: policy.campaign_id,
    batch_id: batch, provider: policy.provider, model: policy.model, inputs,
    payload: prepared.payload, payload_sha256: prepared.digest, native_body: nativeBody,
    endpoint: GATEWAY_ROUTES[policy.provider], method: "POST", content_type: "application/json",
    gateway_policy: policy, gateway_ledger_root: ledgerRoot, driver_sources: sources,
    request_bytes: requestBytes, reservation_upper_microusd: upper,
    accounting: "upper-bound-reservations-no-refund", execution_attestation: false,
    ...(skill ? { skill_proposal: { ...skill.inputs, candidate_out: args.get("candidate-out")!,
      target: { exchange_id: skill.payload.skill_target.exchange_id, target_uri: skill.payload.skill_target.target_uri, base_sha256: skill.payload.skill_target.base_sha256 } } } : {}),
  };
  return { manifest, digest: sha256(canonicalJson(manifest)) };
}

export async function verifyMeteredProposal(args: Map<string, string>) {
  const prepared = await prepareMeteredProposal(args);
  if (!args.get("manifest")) throw new Error("Require --manifest for verification and execution");
  const path = resolve(root, args.get("manifest")!);
  const approved = await readJsonFile<unknown>(path);
  if (canonicalJson(approved.value) !== canonicalJson(prepared.manifest) ||
      await readFile(`${path}.sha256`, "utf8") !== `${prepared.digest}\n`) throw new Error("Metered proposal manifest drift");
  if (prepared.manifest.mode === "live") {
    if (!args.get("approval")) throw new Error("Live execution requires --approval");
    const decision = await verifyApprovalFile(resolve(root, args.get("approval")!), {
      action: "send_data_externally", scope: prepared.digest, at: new Date(),
    });
    if (decision.decision_id !== prepared.manifest.gateway_policy.approval_id) throw new Error("Approval identity mismatch");
  }
  return prepared;
}

async function absent(path: string) {
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Output parent must be an existing real directory");
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("Output already exists");
}

export async function runMeteredProposal(args: Map<string, string>) {
  if (args.get("prepare") === "true") {
    const prepared = await prepareMeteredProposal(args);
    const name = args.get("manifest") ?? args.get("output");
    if (!name) throw new Error("Prepare requires --manifest or --output");
    const path = resolve(root, name);
    await absent(path); await absent(`${path}.sha256`);
    await writeFile(path, `${canonicalJson(prepared.manifest)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(`${path}.sha256`, `${prepared.digest}\n`, { flag: "wx", mode: 0o600 });
    return { status: "prepared", manifest_digest: prepared.digest, path };
  }
  const prepared = await verifyMeteredProposal(args);
  if (args.get("verify") === "true") return { status: "verified", manifest_digest: prepared.digest };
  if (!args.get("output")) throw new Error("Execution requires --output draft path");
  const path = resolve(root, args.get("output")!);
  await absent(path); await absent(`${path}.gateway-receipt.json`);
  if (prepared.manifest.skill_proposal) {
    if (extname(path) !== ".json" || path.startsWith(`${resolve(root, ".dal/candidates")}/`)) throw new Error("Structured candidate output must be JSON outside skill staging");
    await absent(resolve(root, prepared.manifest.skill_proposal.candidate_out));
    await absent(`${path}.optimizer-verdict.json`);
  }
  // Verify once more at the operation boundary, before a listener or capability exists.
  const current = await verifyMeteredProposal(args);
  if (current.digest !== prepared.digest) throw new Error("Proposal changed before gateway startup");
  const { manifest, digest } = current;
  const policy = manifest.gateway_policy;
  const token = randomBytes(32).toString("hex");
  const gateway = await startGateway({ policy, ledgerRoot: manifest.gateway_ledger_root, token, mode: manifest.mode, host: "127.0.0.1", port: 0 });
  let draft;
  let candidate;
  let failure: unknown;
  let receipt: ReturnType<typeof safeGatewayReceipt> | undefined;
  try {
    const response = await fetch(`${gateway.address}${new URL(manifest.endpoint).pathname}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(policy.timeout_ms),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: canonicalJson(manifest.native_body),
    });
    if (!response.ok) throw new Error("Metered proposal broker rejected the request");
    const raw = await response.arrayBuffer();
    if (raw.byteLength > policy.max_response_bytes) throw new Error("Native response exceeds bound");
    const text = parseChatResponse(policy.provider, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    if (manifest.skill_proposal) candidate = await validateSkillProposalReply(text, manifest.skill_proposal.target);
    else draft = await proposeDraft({ payload: manifest.payload, payloadDigest: manifest.payload_sha256, requestDigest: digest,
      model: { provider: policy.provider, model: policy.model }, runnerKind: `${policy.provider}-https`, runner: async () => text });
  } catch (error) { failure = error; }
  try {
    const response = await fetch(`${gateway.address}/receipt`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(policy.timeout_ms) });
    if (!response.ok) throw new Error("Gateway receipt unavailable");
    receipt = safeGatewayReceipt(await response.json(), policy, manifest.mode);
  } catch (error) { failure ??= error; }
  finally { await gateway.close(); }
  // close awaits pending outcome writes. Publish only bounded counters after quiescence.
  if (receipt && !await publishJsonExclusive(`${path}.gateway-receipt.json`, {
    format: "metered-proposal-receipt-v1", manifest_sha256: digest, ...receipt,
    request_bytes: manifest.request_bytes, reservation_upper_microusd: manifest.reservation_upper_microusd,
    draft_validated: draft !== undefined, execution_attestation: false,
    ...(manifest.skill_proposal ? { candidate_validated: candidate !== undefined } : {}),
  })) throw new Error("Receipt output conflict");
  if (failure) throw failure;
  if (manifest.skill_proposal) {
    // Recheck approved bytes after the untrusted response, before publication/reconstruction.
    if ((await verifyMeteredProposal(args)).digest !== digest) throw new Error("Skill inputs changed before staging");
    if (!candidate || !receipt || !await publishJsonExclusive(path, candidate)) throw new Error("Candidate output conflict");
    const evaluated = await evaluateOptimizerCandidate({ exchangePath: manifest.skill_proposal.exchange.path,
      candidatePath: path, candidateOut: manifest.skill_proposal.candidate_out, verdictOut: `${path}.optimizer-verdict.json` });
    if (evaluated.verdict.verdict !== "valid") throw new Error("Skill candidate failed deterministic validation; no skill staged");
    return { status: "recorded", path, manifest_digest: digest, mode: manifest.mode,
      candidate_path: resolve(root, manifest.skill_proposal.candidate_out), candidate_sha256: evaluated.verdict.candidate_sha256,
      verdict_path: `${path}.optimizer-verdict.json` };
  }
  if (!draft || !receipt || !await publishJsonExclusive(path, draft)) throw new Error("Draft output conflict");
  return { status: "recorded", path, manifest_digest: digest, mode: manifest.mode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runMeteredProposal(parseMeteredArguments(process.argv.slice(2))))); }
  catch { process.stderr.write("Metered proposal failed; no automatic retry or refund.\n"); process.exitCode = 1; }
}
