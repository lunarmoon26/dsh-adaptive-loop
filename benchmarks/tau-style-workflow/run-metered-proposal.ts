import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyApprovalFile } from "../../src/approval.js";
import { gatewayReservation, GATEWAY_ROUTES, startGateway } from "../../src/e2e-model-gateway.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "../../src/json.js";
import { prepareProposePayload, proposeDraft } from "../../src/propose.js";
import { parseChatResponse, prepareChatRequest } from "../../src/propose-transport.js";
import { gatewayLedgerRoot, gatewayPolicyTemplate, safeGatewayReceipt } from "./run-e2e.js";

const root = resolve(import.meta.dirname, "../..");
const allowed = ["mode", "campaign", "batch", "provider", "model", "provider-cap-microusd", "clusters", "runs", "output", "approval-id", "approval", "prepare", "verify", "manifest"];

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

export async function prepareMeteredProposal(args: Map<string, string>) {
  if ([...args.keys()].some(key => !allowed.includes(key))) throw new Error("Unknown metered proposal option");
  for (const flag of ["prepare", "verify"]) if (args.has(flag) && args.get(flag) !== "true") throw new Error(`--${flag} accepts only true`);
  if (args.has("prepare") && args.has("verify")) throw new Error("Prepare and verify are exclusive");
  if (args.get("campaign")?.startsWith("rehearsal-")) throw new Error("Campaign uses the reserved rehearsal namespace");
  const batch = args.get("batch");
  if (!batch || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(batch)) throw new Error("Require a safe batch identifier");
  if (!args.get("clusters")) throw new Error("Require --clusters");
  const runId = `run-propose-${sha256(canonicalJson({ campaign: args.get("campaign") ?? "", batch, provider: args.get("provider") ?? "", mode: args.get("mode") ?? "" })).slice(0, 48)}`;
  const policy = gatewayPolicyTemplate(args, runId);
  const ledgerRoot = await gatewayLedgerRoot(new Map());
  const clusters = await inputInventory(args.get("clusters")!, false);
  const runs = args.has("runs") ? await inputInventory(args.get("runs")!, true) : null;
  const inputs = { clusters, runs };
  const prepared = await prepareProposePayload({ clustersDir: clusters.path, ...(runs ? { runsDir: runs.path } : {}) });
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
    ...(await readdir(join(root, "schemas"))).filter(n => n.endsWith(".json")).sort().map(n => `schemas/${n}`),
  ];
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) })));
  const after = { clusters: await inputInventory(clusters.path, false), runs: runs ? await inputInventory(runs.path, true) : null };
  const repeated = await prepareProposePayload({ clustersDir: clusters.path, ...(runs ? { runsDir: runs.path } : {}) });
  if (canonicalJson(inputs) !== canonicalJson(after) || prepared.json !== repeated.json) throw new Error("Input projection drift");
  const manifest = {
    format: "metered-proposal-v1", mode: args.get("mode") as "live" | "rehearsal", campaign_id: policy.campaign_id,
    batch_id: batch, provider: policy.provider, model: policy.model, inputs,
    payload: prepared.payload, payload_sha256: prepared.digest, native_body: nativeBody,
    endpoint: GATEWAY_ROUTES[policy.provider], method: "POST", content_type: "application/json",
    gateway_policy: policy, gateway_ledger_root: ledgerRoot, driver_sources: sources,
    request_bytes: requestBytes, reservation_upper_microusd: upper,
    accounting: "upper-bound-reservations-no-refund", execution_attestation: false,
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
  // Verify once more at the operation boundary, before a listener or capability exists.
  const current = await verifyMeteredProposal(args);
  if (current.digest !== prepared.digest) throw new Error("Proposal changed before gateway startup");
  const { manifest, digest } = current;
  const policy = manifest.gateway_policy;
  const token = randomBytes(32).toString("hex");
  const gateway = await startGateway({ policy, ledgerRoot: manifest.gateway_ledger_root, token, mode: manifest.mode, host: "127.0.0.1", port: 0 });
  let draft;
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
    draft = await proposeDraft({ payload: manifest.payload, payloadDigest: manifest.payload_sha256, requestDigest: digest,
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
  })) throw new Error("Receipt output conflict");
  if (failure) throw failure;
  if (!draft || !receipt || !await publishJsonExclusive(path, draft)) throw new Error("Draft output conflict");
  return { status: "recorded", path, manifest_digest: digest, mode: manifest.mode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runMeteredProposal(parseMeteredArguments(process.argv.slice(2))))); }
  catch { process.stderr.write("Metered proposal failed; no automatic retry or refund.\n"); process.exitCode = 1; }
}
