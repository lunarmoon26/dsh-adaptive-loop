import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256 } from "../../src/json.js";
import { selectedSkillArtifact, gatewayPolicyTemplate, gatewayLedgerRoot } from "../tau-style-workflow/run-e2e.js";
import { inspectPilotCatalog, pilotCompositionPatch, pilotProfile, type PilotProfile } from "./profile.js";
import { gatewayDockerArgv, topologyFor } from "../tau-style-workflow/e2e-topology.js";
import { fetchPilotSources, verifyPilotSources, PILOT_TASKS, PILOT_SOURCE_LOCK, PILOT_COMMIT, PILOT_DSH_IMAGE, PILOT_BASE_TAG, pilotDockerBuildArgs, pilotQualificationCommand, type PilotTask } from "./source.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const STATE = join(ROOT, ".dal/check/skillsbench-pilot");
const TAG = "dsh-adaptive-loop/skillsbench-pilot:local";
const MAX_OUTPUT = 32 * 1024 * 1024;

/** Reject all paid/external-execution options; this pilot stage is keyless only. */
export function parsePilotArgs(argv: string[]) {
  const action = argv[0];
  if (!["fetch", "build", "qualify", "rehearse"].includes(action ?? "")) throw new Error("Use fetch|build|qualify|rehearse; paid execution is disabled");
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!; const value = argv[i + 1];
    if (action !== "rehearse" || !["--skill", "--harness-profile"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) throw new Error("Unsupported pilot option");
    options.set(flag, value);
  }
  return { action: action!, skill: options.get("--skill"), ...(options.has("--harness-profile") ? { harnessProfile: pilotProfile(options.get("--harness-profile")) } : {}) };
}

export async function privateDirectory(path: string) {
  const rel = relative(ROOT, path);
  if (!rel || rel.startsWith("..")) throw new Error("Pilot directory must be root-local");
  let current = ROOT;
  for (const part of rel.split("/")) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) throw new Error("Unsafe pilot directory");
  }
}

export async function docker(args: string[], timeout = 360_000, token?: string, gatewayKey?: string) {
  // Explicit allowlist: never forward provider keys, .env, Docker context or host profile settings.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
  if (token) env.DAL_GATEWAY_TOKEN = token;
  if (gatewayKey) env.OPENAI_API_KEY = gatewayKey;
  return new Promise<{ code: number; output: string }>((done, reject) => {
    const child = spawn("docker", args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let bytes = 0; let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Docker operation timed out"); child.kill("SIGKILL"); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { failure = new Error("Docker output bound exceeded"); child.kill("SIGKILL"); }
      else output += chunk.toString("utf8");
    });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); failure ? reject(failure) : done({ code: code ?? -1, output }); });
  });
}

export const mount = (source: string, target: string, writable = false) => {
  if (source.includes(",") || target.includes(",")) throw new Error("Invalid mount path");
  return ["--mount", `type=bind,src=${source},dst=${target}${writable ? "" : ",readonly"}`];
};

export function pilotContainerArgs(image: string, name: string, output: string, data: string, network = "none") {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Require immutable pilot image");
  return ["run", "--rm", "--name", name, "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "1", "--memory", "4g", "--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,size=256m", "--tmpfs", "/root:rw,nosuid,size=256m",
    "-w", "/root", ...mount(output, "/root/output", true), ...mount(data, "/root/data"), "-e", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1"];
}

/** Snapshot metadata only after the producer is stopped; never follow output links. */
export async function outputInventory(root: string) {
  const result: Array<{ path: string; sha256: string; bytes: number }> = [];
  let total = 0; let entries = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    if (depth > 16) throw new Error("Output nesting bound exceeded");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 2048) throw new Error("Output entry bound exceeded");
      const file = join(path, entry.name); const info = await lstat(file);
      if (info.isDirectory()) await walk(file, depth + 1);
      else {
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_OUTPUT) throw new Error("Unsafe output artifact");
        total += info.size;
        if (total > MAX_OUTPUT) throw new Error("Output tree too large");
        const bytes = await readFile(file);
        if (bytes.length !== info.size) throw new Error("Output changed during collection");
        result.push({ path: relative(root, file), sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  }
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("Unsafe output root");
  await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function buildReceiptPath() {
  return join(STATE, `build-${PILOT_DSH_IMAGE.slice(7)}-${sha256(await readFile(join(import.meta.dirname, "Dockerfile")))}.json`);
}
export async function imageIdentity() {
  const result = await docker(["image", "inspect", TAG, "--format", "{{.Id}}"]);
  const image = result.output.trim();
  if (result.code || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Build pilot image first");
  const receipt = JSON.parse(await readFile(await buildReceiptPath(), "utf8"));
  if (receipt.image !== image || receipt.dockerfile !== sha256(await readFile(join(import.meta.dirname, "Dockerfile")))) throw new Error("Pilot image/build drift");
  return image;
}

export async function runContainer(args: string[], name: string, log: string, token?: string) {
  try {
    const result = await docker(args, 360_000, token);
    await writeFile(log, result.output, { flag: "wx", mode: 0o600 });
    return result;
  } finally {
    // Names are fresh and owned by this invocation; stop timed-out background work before grading.
    const stopped = await docker(["rm", "-f", name], 30_000);
    if (stopped.code && !stopped.output.includes("No such container")) throw new Error("Cannot confirm container cleanup");
  }
}

async function qualification(image: string, trial: string, task: PilotTask, mode: "oracle" | "nop") {
  const sources = await verifyPilotSources(ROOT);
  const taskRoot = join(sources.root, "tasks", task);
  const dir = join(trial, `${task}-${mode}`); await privateDirectory(dir);
  const output = join(dir, "output"); await privateDirectory(output);
  const id = `dal-sb-${randomBytes(8).toString("hex")}`;
  const boot = "ln -s /opt/pilot-js/node_modules /root/node_modules; ";
  const producer = await runContainer([...pilotContainerArgs(image, id, output, join(taskRoot, "environment/data")),
    ...(mode === "oracle" ? mount(join(taskRoot, "oracle"), "/oracle") : []), image,
    "/bin/bash", "-euc", boot + (mode === "oracle" ? "exec bash /oracle/solve.sh" : "true")], id, join(dir, "producer.log"));
  if (producer.code) throw new Error(`${task} ${mode} producer failed; see private log`);
  const verified = await gradeOutput(image, dir, task, output, id);
  return { task, mode, ...verified, qualified: mode === "oracle" ? verified.pass : !verified.pass };
}

export async function gradeOutput(image: string, dir: string, task: PilotTask, output: string, id: string) {
  const sources = await verifyPilotSources(ROOT);
  const taskRoot = join(sources.root, "tasks", task);
  const boot = "ln -s /opt/pilot-js/node_modules /root/node_modules; ";
  const inventory = await outputInventory(output);
  const verifierId = `${id}-verify`;
  const verification = join(dir, "verification"); await privateDirectory(verification);
  const verifierArgs = pilotContainerArgs(image, verifierId, output, join(taskRoot, "environment/data"));
  // Read-only outputs; pristine data and private oracle code exist only in verifier.
  const outputMount = verifierArgs.indexOf(`type=bind,src=${output},dst=/root/output`);
  verifierArgs[outputMount] += ",readonly";
  const command = pilotQualificationCommand("verify");
  const verified = await runContainer([...verifierArgs, ...mount(verification, "/verification", true), ...mount(join(taskRoot, "verifier"), "/verifier"), image,
    ...command.slice(0, -1), boot + command.at(-1)!], verifierId, join(dir, "verifier.log"));
  const junit = await readFile(join(verification, "junit.xml"), "utf8");
  const pass = verifierPass(verified.code, junit);
  if (canonicalJson(inventory) !== canonicalJson(await outputInventory(output))) throw new Error("Output changed during verification");
  return { pass, inventory,
    verifier_log_sha256: sha256(verified.output), junit_sha256: sha256(junit) };
}

/** Only the three collected outcome tests can establish pass or valid no-op failure. */
export function verifierPass(code: number, xml: string): boolean {
  if (Buffer.byteLength(xml) > MAX_OUTPUT || ![0, 1].includes(code)) throw new Error("Verifier infrastructure failed");
  const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)];
  if (suites.length !== 1) throw new Error("Expected one verifier test suite");
  const number = (name: string) => {
    const match = suites[0]![0].match(new RegExp(`\\b${name}="(\\d+)"`));
    if (!match) throw new Error("Incomplete verifier report");
    return Number(match[1]);
  };
  const failures = number("failures");
  if (number("tests") !== 3 || number("errors") !== 0 || number("skipped") !== 0 || failures > 3 || (code === 0) !== (failures === 0)) throw new Error("Verifier infrastructure failed");
  return code === 0;
}

async function rehearse(image: string, trial: string, skillPath?: string, profile: PilotProfile = "standard") {
  const sources = await verifyPilotSources(ROOT);
  const base = join(sources.root, "tasks", PILOT_TASKS.development, "environment");
  const selected = await selectedSkillArtifact(new Map([["skill", skillPath ?? join(base, "skills/obj-exporter/SKILL.md")]]));
  const stage = join(trial, "skills"); await privateDirectory(join(stage, "obj-exporter"));
  const prefix = `tasks/${PILOT_TASKS.development}/environment/skills/`;
  for (const file of PILOT_SOURCE_LOCK.filter(file => file.path.startsWith(prefix) && !file.path.endsWith("/obj-exporter/SKILL.md"))) {
    const destination = join(stage, file.path.slice(prefix.length));
    await privateDirectory(resolve(destination, ".."));
    await writeFile(destination, await readFile(join(sources.root, file.path)), { flag: "wx", mode: 0o600 });
  }
  await copyFile(selected.path, join(stage, "obj-exporter/SKILL.md"));
  if (sha256(await readFile(join(stage, "obj-exporter/SKILL.md"))) !== selected.sha256) throw new Error("Skill staging drift");
  const output = join(trial, "output"); await privateDirectory(output);
  const home = join(trial, "dsh-home"); await privateDirectory(home);
  const topology = topologyFor(`sb-${randomBytes(8).toString("hex")}`);
  const token = randomBytes(32).toString("hex");
  const policy = gatewayPolicyTemplate(new Map([["mode", "rehearsal"], ["campaign", "skillsbench-pilot"], ["provider", "openai"], ["model", "gpt-5.6-terra"], ["provider-cap-microusd", "6000000"]]), `run-${topology.id}`);
  const policyPath = join(trial, "policy.json"); await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600, flag: "wx" });
  const patch = pilotCompositionPatch(profile);
  const patchPath = join(trial, "patch.yml"); await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
  const network = await docker(["network", "create", "--internal", topology.candidateNetwork]);
  if (network.code) throw new Error("Internal network creation failed");
  try {
    const gateway = await docker(gatewayDockerArgv({ image, topology, policyPath, ledgerRoot: await gatewayLedgerRoot(new Map()), mode: "rehearsal", provider: "openai" }), 30_000, token);
    if (gateway.code) throw new Error("Keyless gateway startup failed");
    await new Promise(r => setTimeout(r, 1500));
    const args = [...pilotContainerArgs(image, topology.candidateContainer, output, join(base, "data"), topology.candidateNetwork),
      ...mount(stage, "/root/.agents/skills"), ...mount(home, "/dsh-home", true), ...mount(patchPath, "/pilot-patch.yml"),
      "-e", "DSH_HOME=/dsh-home", "-e", "DAL_GATEWAY_TOKEN", image, "/bin/bash", "-euc",
      "ln -s /opt/pilot-js/node_modules /root/node_modules; exec node --expose-internals --import /opt/dal/dist/e2e-openai-text-replay-preload.js /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --patch /pilot-patch.yml \"$1\"", "pilot", sources.prompts[PILOT_TASKS.development]];
    const result = await runContainer(args, topology.candidateContainer, join(trial, "dsh.log"), token);
    const inventory = await outputInventory(output);
    const marker = await readFile(join(output, "protocol.txt"), "utf8");
    const observed = await readFile(join(output, "skill.sha256"), "utf8");
    if (result.code || marker !== "pilot-shell-ok" || observed.split(/\s/)[0] !== selected.sha256) throw new Error("DSH shell/skill rehearsal failed");
    const catalog = await inspectPilotCatalog(home, profile);
    return { mode: "rehearsal", protocol_pass: true, model_improvement: false, skill_uri: selected.uri, skill_sha256: selected.sha256,
      harness_profile: profile, patch_sha256: sha256(patch), catalog, mounted_skills: await outputInventory(stage), inventory };
  } finally {
    const errors = [];
    try {
      const removed = await docker(["rm", "-f", topology.gatewayContainer], 30_000);
      if (removed.code && !removed.output.includes("No such container")) errors.push("gateway");
    } catch { errors.push("gateway"); }
    try {
      const removed = await docker(["network", "rm", topology.candidateNetwork], 30_000);
      if (removed.code) errors.push("network");
    } catch { errors.push("network"); }
    if (errors.length) throw new Error(`Pilot cleanup failed: ${errors.join(", ")}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parsePilotArgs(argv);
  await privateDirectory(STATE);
  if (args.action === "fetch") {
    const sources = await fetchPilotSources(ROOT);
    console.log(JSON.stringify({ status: "verified", commit: PILOT_COMMIT, files: sources.inventory.length })); return;
  }
  if (args.action === "build") {
    try {
      await lstat(await buildReceiptPath());
      console.log(JSON.stringify({ image: await imageIdentity(), reused: true })); return;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const tagged = await docker(["tag", PILOT_DSH_IMAGE, PILOT_BASE_TAG]);
    if (tagged.code) throw new Error("Pinned DSH base is unavailable; build the gateway image first");
    const build = await docker([...pilotDockerBuildArgs().slice(0, -1), "-t", TAG, "benchmarks/skillsbench-pilot"], 600_000);
    await writeFile(join(STATE, `build-${Date.now()}.log`), build.output, { flag: "wx", mode: 0o600 });
    if (build.code) throw new Error("Pilot build failed; see private build log");
    const base = await docker(["image", "inspect", PILOT_BASE_TAG, "--format", "{{.Id}}"]);
    if (base.code || base.output.trim() !== PILOT_DSH_IMAGE) throw new Error("Build base drift");
    const identity = await docker(["image", "inspect", TAG, "--format", "{{.Id}}"]);
    if (identity.code) throw new Error("Cannot inspect pilot image");
    const receipt = { image: identity.output.trim(), dockerfile: sha256(await readFile(join(import.meta.dirname, "Dockerfile"))) };
    await writeFile(await buildReceiptPath(), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(receipt)); return;
  }
  await verifyPilotSources(ROOT);
  const image = await imageIdentity();
  const trial = await mkdtemp(join(STATE, `${args.action}-`));
  const evidence = args.action === "qualify" ? await (async () => {
    const rows = [];
    for (const task of Object.values(PILOT_TASKS)) for (const mode of ["oracle", "nop"] as const) rows.push(await qualification(image, trial, task, mode));
    return rows;
  })() : await rehearse(image, trial, args.skill, args.harnessProfile);
  const report = { version: "skillsbench-pilot.v1", commit: PILOT_COMMIT, image, source_inventory_sha256: sha256(canonicalJson(PILOT_SOURCE_LOCK)),
    driver_sha256: sha256(await readFile(import.meta.filename)), action: args.action, evidence, paid_execution: false, promotion_authorized: false };
  await writeFile(join(trial, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ report: relative(ROOT, join(trial, "report.json")), evidence: Array.isArray(evidence)
    ? evidence.map(({ task, mode, pass, qualified }) => ({ task, mode, pass, qualified }))
    : { mode: evidence.mode, protocol_pass: evidence.protocol_pass, skill_sha256: evidence.skill_sha256, harness_profile: evidence.harness_profile, catalog: evidence.catalog, model_improvement: false } }));
  if (Array.isArray(evidence) && evidence.some(row => !row.qualified)) throw new Error("Task qualification failed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
