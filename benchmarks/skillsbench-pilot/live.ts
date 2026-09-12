import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyApprovalFile } from "../../src/approval.js";
import { verifyImageBuildProvenance } from "../../src/e2e-build-provenance.js";
import { canonicalJson, publishJsonExclusive, sha256 } from "../../src/json.js";
import { readProposalBudgetSnapshot } from "../../src/proposal-budget.js";
import { ingestRunRecord } from "../../src/runs.js";
import type { RunRecord } from "../../src/types.js";
import { evaluateOptimizerCandidate } from "../../src/optimizer-adapter.js";
import { captureSession, gatewayLedgerRoot, gatewayPolicyTemplate, safeGatewayReceipt, selectedSkillArtifact } from "../tau-style-workflow/run-e2e.js";
import { inspectPilotCatalog, pilotCompositionPatch, pilotProfile } from "./profile.js";
import { gatewayDockerArgv, topologyFor } from "../tau-style-workflow/e2e-topology.js";
import { PILOT_COMMIT, PILOT_SOURCE_LOCK, PILOT_TASKS, verifyPilotSources, type PilotTask } from "./source.js";
import { ROOT, STATE, docker, gradeOutput, imageIdentity, mount, outputInventory, pilotContainerArgs, privateDirectory, runContainer, verifierPass } from "./run.js";

const CAMPAIGN = "paid-adaptive-20260908";
const LIMIT = 12_123_852;
const GENERATIONS = ["g0", "g1"] as const;
export function parseLiveArgs(argv: string[]) {
  const [action, ...rest] = argv;
  if (!["prepare", "run", "assess", "compare", "enroll"].includes(action ?? "")) throw new Error("Use prepare|run|assess|compare|enroll");
  const args = new Map<string, string>();
  const allowed = action === "assess" || action === "enroll" ? ["receipt"] : action === "compare" ? ["baseline", "candidate"] : ["batch", "task", "generation", "skill", "qualification", "approval-id", "approval", "manifest", "exchange", "candidate", "harness-profile"];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, ""); const value = rest[i + 1];
    if (!rest[i]?.startsWith("--") || !key || !allowed.includes(key) || args.has(key) || !value || value.startsWith("--")) throw new Error("Invalid live pilot option");
    args.set(key, value);
  }
  if (args.has("harness-profile")) pilotProfile(args.get("harness-profile"));
  return { action: action!, args };
}

async function localFile(name: string) {
  const path = resolve(ROOT, name); const rel = relative(ROOT, path);
  if (!rel || rel.startsWith("..") || /(^|\/)\.env(?:[./]|$)/.test(path) || await realpath(path) !== path) throw new Error("Require real root-local non-env evidence");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error("Unsafe evidence file");
  const raw = await readFile(path);
  return { path, uri: rel, raw, sha256: sha256(raw) };
}
const required = (args: Map<string, string>, key: string) => {
  const value = args.get(key); if (!value) throw new Error(`Require --${key}`); return value;
};

async function qualificationEvidence(name: string, image: string) {
  const file = await localFile(name); const report = JSON.parse(file.raw.toString("utf8"));
  if (report.action !== "qualify" || report.image !== image || report.commit !== PILOT_COMMIT || report.paid_execution !== false || report.source_inventory_sha256 !== sha256(canonicalJson(PILOT_SOURCE_LOCK)) || !Array.isArray(report.evidence) || report.evidence.length !== 4) throw new Error("Qualification context mismatch");
  for (const task of Object.values(PILOT_TASKS)) for (const mode of ["oracle", "nop"]) {
    const rows = report.evidence.filter((row: { task: string; mode: string }) => row.task === task && row.mode === mode);
    if (rows.length !== 1 || rows[0].qualified !== true || rows[0].pass !== (mode === "oracle")) throw new Error("Task is not qualified");
    const dir = resolve(file.path, "..", `${task}-${mode}`);
    const xml = await localFile(join(dir, "verification/junit.xml"));
    const log = await localFile(join(dir, "verifier.log"));
    if (xml.sha256 !== rows[0].junit_sha256 || log.sha256 !== rows[0].verifier_log_sha256 || verifierPass(mode === "oracle" ? 0 : 1, xml.raw.toString("utf8")) !== (mode === "oracle")) throw new Error("Qualification evidence drift");
  }
  return { path: file.uri, sha256: file.sha256 };
}

export async function prepareLive(args: Map<string, string>) {
  const profile = pilotProfile(args.get("harness-profile"));
  const batch = required(args, "batch");
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(batch)) throw new Error("Invalid batch");
  const task = required(args, "task") as PilotTask;
  const generation = required(args, "generation");
  if (!Object.values(PILOT_TASKS).includes(task) || !GENERATIONS.some(g => g === generation)) throw new Error("Invalid task or generation");
  const sources = await verifyPilotSources(ROOT);
  const upstreamSkill = join(sources.root, "tasks", PILOT_TASKS.development, "environment/skills/obj-exporter/SKILL.md");
  const baseBytes = await readFile(upstreamSkill);
  const defaultSkill = join(ROOT, ".dal/candidates", `skillsbench-base-${sha256(baseBytes).slice(0, 16)}.md`);
  if (!args.has("skill")) {
    await privateDirectory(resolve(defaultSkill, ".."));
    try { await writeFile(defaultSkill, baseBytes, { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    if ((await selectedSkillArtifact(new Map([["skill", defaultSkill]]))).sha256 !== sha256(baseBytes)) throw new Error("Baseline skill drift");
  }
  const skill = await selectedSkillArtifact(new Map([["skill", args.get("skill") ?? defaultSkill]]));
  if (generation === "g0" && skill.sha256 !== sha256(baseBytes)) throw new Error("G0 must use the unchanged upstream development skill");
  if (generation === "g1" && skill.sha256 === sha256(baseBytes)) throw new Error("G1 requires a changed skill artifact");
  let candidateEvidence = null;
  if (generation === "g1") {
    const exchange = await localFile(required(args, "exchange")); const candidate = await localFile(required(args, "candidate"));
    const expectedUri = `repo://${relative(ROOT, defaultSkill)}`;
    if (JSON.parse(exchange.raw.toString("utf8")).target?.artifact_uri !== expectedUri) throw new Error("Candidate exchange must target the fixed pilot baseline");
    const evaluated = await evaluateOptimizerCandidate({ exchangePath: exchange.path, candidatePath: candidate.path });
    if (evaluated.verdict.verdict !== "valid" || evaluated.verdict.candidate_sha256 !== skill.sha256) throw new Error("G1 is not the validated bounded candidate");
    candidateEvidence = { exchange: { path: exchange.uri, sha256: exchange.sha256 }, candidate: { path: candidate.uri, sha256: candidate.sha256 },
      verdict_sha256: sha256(canonicalJson({ checks: evaluated.verdict.checks, base_sha256: evaluated.verdict.base_sha256,
        candidate_sha256: evaluated.verdict.candidate_sha256, exchange_id: evaluated.verdict.exchange_id, verdict: evaluated.verdict.verdict })) };
  } else if (args.has("exchange") || args.has("candidate")) throw new Error("G0 cannot carry candidate evidence");
  const image = await imageIdentity();
  const provenance = await verifyImageBuildProvenance(ROOT, image);
  const qualification = await qualificationEvidence(required(args, "qualification"), image);
  const driverPaths = ["benchmarks/skillsbench-pilot/live.ts", "benchmarks/skillsbench-pilot/run.ts", "benchmarks/skillsbench-pilot/source.ts", "benchmarks/skillsbench-pilot/profile.ts",
    "benchmarks/tau-style-workflow/run-e2e.ts", "benchmarks/tau-style-workflow/e2e-prompt.ts", "benchmarks/tau-style-workflow/e2e-topology.ts",
    "src/approval.ts", "src/json.ts", "src/privacy.ts", "src/proposal-budget.ts", "src/e2e-model-gateway.ts", "src/optimizer-adapter.ts", "src/optimizer.ts"];
  const drivers = await Promise.all(driverPaths.map(async path => ({ path, sha256: sha256(await readFile(join(ROOT, path))) })));
  const patch = pilotCompositionPatch(profile);
  const runId = `run-sb-${sha256(`${CAMPAIGN}:${batch}`).slice(0, 48)}`;
  const policy = gatewayPolicyTemplate(new Map([["mode", "live"], ["campaign", CAMPAIGN], ["provider", "openai"], ["model", "gpt-5.6-terra"], ["provider-cap-microusd", String(LIMIT)], ["approval-id", required(args, "approval-id")]]), runId);
  const context = { task, image, provenance, drivers, upstream_commit: PILOT_COMMIT, source_lock: PILOT_SOURCE_LOCK, patch,
    prompt: sources.prompts[task], provider: "openai", model: "gpt-5.6-terra", timeout_ms: 360000, cpus: 1, memory_mb: 4096,
    network: "candidate-internal-gateway-only", cumulative_cap_microusd: LIMIT, campaign: CAMPAIGN };
  const manifest = { version: "skillsbench-live-manifest.v1", ...context, context_sha256: sha256(canonicalJson(context)), qualification,
    batch, run_id: runId, generation, harness_profile: profile, candidate_evidence: candidateEvidence, policy, ledger_root: await gatewayLedgerRoot(new Map()), skill: { uri: skill.uri, sha256: skill.sha256, bytes: skill.size_bytes } };
  return { manifest, digest: sha256(canonicalJson(manifest)), skillPath: skill.path };
}
type Manifest = Awaited<ReturnType<typeof prepareLive>>["manifest"];
export function contextDigest(m: Record<string, unknown>) {
  return sha256(canonicalJson(Object.fromEntries(["task", "image", "provenance", "drivers", "upstream_commit", "source_lock", "patch", "prompt", "provider", "model", "timeout_ms", "cpus", "memory_mb", "network", "cumulative_cap_microusd", "campaign"].map(key => [key, m[key]]))));
}

async function verifyPrepared(args: Map<string, string>) {
  const prepared = await prepareLive(args);
  const file = await localFile(required(args, "manifest"));
  if (canonicalJson(JSON.parse(file.raw.toString("utf8"))) !== canonicalJson(prepared.manifest)) throw new Error("Live manifest drift");
  const approval = await verifyApprovalFile(required(args, "approval"), { action: "send_data_externally", scope: prepared.digest, at: new Date() });
  if (approval.decision_id !== prepared.manifest.policy.approval_id) throw new Error("Approval ID does not match the gateway policy");
  return prepared;
}

export async function runLive(args: Map<string, string>) {
  const prepared = await verifyPrepared(args);
  const m = prepared.manifest;
  const ledger = await readProposalBudgetSnapshot({ store: m.ledger_root, budgetId: CAMPAIGN, provider: "openai" });
  if (ledger.provider_limit_microusd !== LIMIT) throw new Error("Approve and apply the explicit cumulative budget extension first");
  const trial = join(STATE, "live", m.batch);
  try { await lstat(trial); throw new Error("Batch already claimed; no retries"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  // Exact approval and cap verification precede credential access and exclusive claim.
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing launcher credential");
  await privateDirectory(join(STATE, "live"));
  const { mkdir } = await import("node:fs/promises"); await mkdir(trial, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  await writeFile(join(trial, "manifest.json"), JSON.stringify(m, null, 2), { flag: "wx", mode: 0o600 });
  const source = await verifyPilotSources(ROOT);
  const skills = join(trial, "skills"); await privateDirectory(skills);
  const prefix = `tasks/${PILOT_TASKS.development}/environment/skills/`;
  for (const file of PILOT_SOURCE_LOCK.filter(file => file.path.startsWith(prefix))) {
    const path = join(skills, file.path.slice(prefix.length)); await privateDirectory(resolve(path, ".."));
    const bytes = file.path.endsWith("/obj-exporter/SKILL.md") ? await readFile(prepared.skillPath) : await readFile(join(source.root, file.path));
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
  if (sha256(await readFile(join(skills, "obj-exporter/SKILL.md"))) !== m.skill.sha256) throw new Error("Staged skill drift");
  const mountedSkills = await outputInventory(skills);
  const output = join(trial, "output"); const home = join(trial, "dsh-home");
  await privateDirectory(output); await privateDirectory(home);
  const policyPath = join(trial, "policy.json"); const patchPath = join(trial, "patch.yml");
  await writeFile(policyPath, JSON.stringify(m.policy), { flag: "wx", mode: 0o600 });
  await writeFile(patchPath, m.patch, { flag: "wx", mode: 0o600 });
  if ((await verifyPrepared(args)).digest !== prepared.digest) throw new Error("Manifest changed before execution");
  const t = topologyFor(m.run_id); const token = randomBytes(32).toString("hex");
  let executed = false; let grade: Awaited<ReturnType<typeof gradeOutput>> | null = null; let failure: string | null = null;
  let gatewayReceipt: ReturnType<typeof safeGatewayReceipt> | null = null;
  let catalog: Awaited<ReturnType<typeof inspectPilotCatalog>> | null = null;
  const created: string[] = [];
  try {
    for (const [network, internal] of [[t.candidateNetwork, true], [t.outboundNetwork, false]] as const) {
      const result = await docker(["network", "create", ...(internal ? ["--internal"] : []), network]);
      if (result.code) throw new Error("network"); created.push(network);
    }
    const gateway = await docker(gatewayDockerArgv({ image: m.image, topology: t, policyPath, ledgerRoot: m.ledger_root, mode: "live", provider: "openai" }), 30000, token, key);
    if (gateway.code) throw new Error("gateway");
    if ((await docker(["network", "connect", t.outboundNetwork, t.gatewayContainer])).code) throw new Error("outbound");
    // Readiness is checked inside the owned gateway, not by exposing a host port.
    const ready = await docker(["exec", t.gatewayContainer, "node", "-e", "(async()=>{for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:8787/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)})()"]);
    if (ready.code) throw new Error("readiness");
    const command = [...pilotContainerArgs(m.image, t.candidateContainer, output, join(source.root, "tasks", m.task, "environment/data"), t.candidateNetwork),
      ...mount(skills, "/root/.agents/skills"), ...mount(home, "/dsh-home", true), ...mount(patchPath, "/pilot-patch.yml"),
      "-e", "DSH_HOME=/dsh-home", "-e", "DAL_GATEWAY_TOKEN", m.image, "/bin/bash", "-euc",
      "ln -s /opt/pilot-js/node_modules /root/node_modules; exec node --expose-internals --import /opt/dal/dist/e2e-openai-text-replay-preload.js /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --patch /pilot-patch.yml \"$1\"", "pilot", m.prompt];
    const result = await runContainer(command, t.candidateContainer, join(trial, "dsh.log"), token);
    executed = result.code === 0;
    const stats = await docker(["exec", t.gatewayContainer, "node", "-e", "fetch('http://127.0.0.1:8787/receipt',{headers:{authorization:'Bearer '+process.env.DAL_GATEWAY_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"]);
    if (stats.code) throw new Error("gateway_receipt");
    gatewayReceipt = safeGatewayReceipt(JSON.parse(stats.output), m.policy, "live");
    await writeFile(join(trial, "gateway.json"), JSON.stringify(gatewayReceipt), { flag: "wx", mode: 0o600 });
    if (!gatewayReceipt.process_counts.completed || gatewayReceipt.process_counts.failed || gatewayReceipt.process_counts.rejected) { executed = false; failure = "gateway_failed"; }
    if (!executed) failure = "harness_failed";
    else {
      catalog = await inspectPilotCatalog(home, m.harness_profile);
      grade = await gradeOutput(m.image, trial, m.task, output, `${t.id}-grade`);
    }
  } catch { failure = executed ? "verification_failed" : "execution_failed"; }
  finally {
    for (const container of [t.candidateContainer, t.gatewayContainer]) {
      try { const result = await docker(["rm", "-f", container], 30000); if (result.code && !result.output.includes("No such container")) failure = "cleanup_failed"; }
      catch { failure = "cleanup_failed"; }
    }
    for (const network of created.reverse()) {
      try { if ((await docker(["network", "rm", network], 30000)).code) failure = "cleanup_failed"; } catch { failure = "cleanup_failed"; }
    }
  }
  const after = await readProposalBudgetSnapshot({ store: m.ledger_root, budgetId: CAMPAIGN, provider: "openai" });
  const receipt = { version: "skillsbench-live-receipt.v1", manifest_sha256: prepared.digest, manifest_path: relative(ROOT, join(trial, "manifest.json")),
    session: await captureSession(home),
    started_at: startedAt, finished_at: new Date().toISOString(),
    run_id: m.run_id, mode: "live", execution_succeeded: executed, failure, grade, mounted_skills: mountedSkills,
    gateway_sha256: gatewayReceipt ? sha256(JSON.stringify(gatewayReceipt)) : null, harness_catalog: catalog,
    allocation_before_microusd: ledger.reserved_microusd, allocation_after_microusd: after.reserved_microusd,
    promotion_authorized: false, independent_execution_attestation: false };
  if (!await publishJsonExclusive(join(trial, "receipt.json"), receipt)) throw new Error("Receipt conflict");
  return { path: relative(ROOT, join(trial, "receipt.json")), receipt };
}

export async function readLiveReceipt(name: string) {
  const file = await localFile(name); const receipt = JSON.parse(file.raw.toString("utf8"));
  if (receipt.version !== "skillsbench-live-receipt.v1" || receipt.mode !== "live" || receipt.promotion_authorized !== false || !receipt.execution_succeeded || receipt.failure || !receipt.grade) throw new Error("Not a completed live business outcome");
  const mf = await localFile(receipt.manifest_path); const m = JSON.parse(mf.raw.toString("utf8")) as Manifest;
  if (m.version !== "skillsbench-live-manifest.v1" || sha256(canonicalJson(m)) !== receipt.manifest_sha256 || contextDigest(m) !== m.context_sha256 || m.run_id !== receipt.run_id || !Object.values(PILOT_TASKS).includes(m.task)) throw new Error("Receipt identity mismatch");
  const dir = resolve(file.path, ".."); const grade = receipt.grade;
  if (receipt.harness_catalog !== undefined && canonicalJson(receipt.harness_catalog) !== canonicalJson(await inspectPilotCatalog(join(dir, "dsh-home"), pilotProfile(m.harness_profile)))) throw new Error("Native harness catalog drift");
  const gw = await localFile(join(dir, "gateway.json")); const gateway = safeGatewayReceipt(JSON.parse(gw.raw.toString("utf8")), m.policy, "live");
  if (gw.sha256 !== receipt.gateway_sha256 || !gateway.process_counts.completed || gateway.process_counts.failed || gateway.process_counts.rejected || gateway.reserved_microusd <= receipt.allocation_before_microusd || gateway.reserved_microusd > receipt.allocation_after_microusd) throw new Error("Gateway evidence mismatch");
  const xml = await localFile(join(dir, "verification/junit.xml")); const log = await localFile(join(dir, "verifier.log"));
  if (grade.junit_sha256 !== xml.sha256 || grade.verifier_log_sha256 !== log.sha256 || verifierPass(grade.pass ? 0 : 1, xml.raw.toString("utf8")) !== grade.pass || canonicalJson(grade.inventory) !== canonicalJson(await outputInventory(join(dir, "output")))) throw new Error("Grader evidence drift");
  if (canonicalJson(receipt.mounted_skills) !== canonicalJson(await outputInventory(join(dir, "skills"))) || sha256(await readFile(join(dir, "skills/obj-exporter/SKILL.md"))) !== m.skill.sha256) throw new Error("Mounted skill drift");
  return { receipt, manifest: m, sha256: file.sha256, path: file.uri };
}

export async function assessLive(name: string) {
  const evidence = await readLiveReceipt(name);
  if (evidence.manifest.task !== PILOT_TASKS.development || evidence.manifest.generation !== "g0") throw new Error("Require development g0 baseline");
  return { status: evidence.receipt.grade.pass ? "no_change_needed" : "failure_requires_causal_review", evidence: { path: evidence.path, sha256: evidence.sha256 }, promotion_authorized: false };
}

/** Deterministic, sanitized development projection; no oracle text, coordinates or raw trajectory. */
export async function pilotRunRecord(name: string): Promise<RunRecord> {
  const e = await readLiveReceipt(name); const m = e.manifest; const r = e.receipt;
  if (m.task !== PILOT_TASKS.development || m.generation !== "g0" || !Number.isFinite(Date.parse(r.started_at)) || !Number.isFinite(Date.parse(r.finished_at))) throw new Error("Only dated development baselines can be enrolled");
  const xml = await readFile(resolve(ROOT, e.path, "..", "verification/junit.xml"), "utf8");
  const session = await captureSession(resolve(ROOT, e.path, "..", "dsh-home"));
  if (!session.observation || !session.eventLogHead || canonicalJson(session) !== canonicalJson(r.session)) throw new Error("Missing or drifted DSH session evidence");
  const cases = [...xml.matchAll(/<testcase\b[^>]*(?:\/>|>[\s\S]*?<\/testcase>)/g)];
  if (cases.length !== 3) throw new Error("Missing individual checks");
  const checks = cases.map(([text]) => {
    const id = text.match(/\bname="([a-zA-Z0-9_]+)"/)?.[1];
    if (!id) throw new Error("Unexpected check name");
    const pass = !/<failure\b/.test(text);
    return { id: `test:${id}`, pass, detail: pass ? "Verifier assertion passed" : "Verifier assertion failed",
      goal_sha256: sha256(canonicalJson(PILOT_SOURCE_LOCK.filter(f => f.path.startsWith(`tasks/${m.task}/verifier/`)))),
      actual_sha256: sha256(canonicalJson(r.grade.inventory)) };
  });
  const earned = checks.filter(c => c.pass).length;
  if ((earned === 3) !== r.grade.pass) throw new Error("Check aggregate mismatch");
  return {
    $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json", schema_version: "1.0.0", run_id: m.run_id, task_id: m.task,
    change_id: "chg-dal-skillsbench-paid-pilot-20260911", started_at: r.started_at, finished_at: r.finished_at, outcome: "succeeded", failure: null,
    batch_id: m.batch, context: { task_set: "skillsbench-geometry-pilot", environment_snapshot: m.image, tool_versions: [], model: { id: m.model, version: m.provider },
      prompt_sha256: sha256(m.prompt), harness_sha256: m.context_sha256, grader_version: `1.0.0+skillsbench.${PILOT_COMMIT.slice(0, 12)}`, seeds: [],
      context_policy_sha256: m.context_sha256, inference_parameters: [], harness_pins: [{ surface: "skills", uri: m.skill.uri, sha256: m.skill.sha256 }] },
    artifacts: [], checks, business_outcome: { status: earned === 3 ? "passed" : "failed", source: "repo://benchmarks/skillsbench-pilot/live.ts", score: earned / 3, earned, total: 3 },
    metrics: { duration_ms: Date.parse(r.finished_at) - Date.parse(r.started_at), tool_calls: session.observation.tool_calls,
      ...(session.observation.input_tokens === undefined ? {} : { input_tokens: session.observation.input_tokens, output_tokens: session.observation.output_tokens }) }, evidence: [`repo://${e.path}`],
    privacy: { classification: "internal", contains_personal_data: false, redactions: [] },
  };
}
export async function compareLive(baseline: string, candidate: string) {
  const b = await readLiveReceipt(baseline); const c = await readLiveReceipt(candidate);
  if (b.manifest.context_sha256 !== c.manifest.context_sha256 || b.manifest.generation !== "g0" || c.manifest.generation !== "g1" || b.manifest.skill.sha256 === c.manifest.skill.sha256 || b.receipt.run_id === c.receipt.run_id || b.manifest.task !== c.manifest.task) throw new Error("Non-comparable pilot trials");
  const delta = Number(c.receipt.grade.pass) - Number(b.receipt.grade.pass);
  return { status: delta > 0 ? "improved_on_evaluated_case" : delta < 0 ? "regression" : "no_improvement", delta, task: b.manifest.task,
    evidence: [b.path, c.path], promotion_authorized: false, claim: "One paired local evaluation, not an official score or reliability estimate" };
}

async function main() {
  const { action, args } = parseLiveArgs(process.argv.slice(2));
  if (action === "enroll") {
    const name = required(args, "receipt"); const record = await pilotRunRecord(name);
    const dir = resolve(ROOT, name, ".."); const path = join(dir, "development-run.json");
    await publishJsonExclusive(path, record);
    console.log(JSON.stringify(await ingestRunRecord(path, join(dir, "runs")), null, 2));
  }
  else if (action === "assess") console.log(JSON.stringify(await assessLive(required(args, "receipt")), null, 2));
  else if (action === "compare") console.log(JSON.stringify(await compareLive(required(args, "baseline"), required(args, "candidate")), null, 2));
  else if (action === "run") console.log(JSON.stringify(await runLive(args), null, 2));
  else {
    const p = await prepareLive(args); await privateDirectory(join(STATE, "manifests"));
    const path = join(STATE, "manifests", `${p.digest}.json`);
    if (!await publishJsonExclusive(path, p.manifest)) {
      if (canonicalJson(JSON.parse((await localFile(path)).raw.toString("utf8"))) !== canonicalJson(p.manifest)) throw new Error("Manifest conflict");
    }
    console.log(JSON.stringify({ path: relative(ROOT, path), digest: p.digest, task: p.manifest.task, cap: LIMIT }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
