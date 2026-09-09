import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const SERVICE_ALIAS = "dal-workflow-service";
export const SERVICE_PORT = 8787;
export const SERVICE_URL = `http://${SERVICE_ALIAS}:${SERVICE_PORT}`;
export const CONTAINER_PATCH_PATH = "/workspace/.dal/benchmark/e2e/model-patch.yml";

export interface DockerTopology {
  id: string;
  candidateNetwork: string;
  graderNetwork: string;
  serviceContainer: string;
  candidateContainer: string;
  graderContainer: string;
  gatewayContainer: string;
  outboundNetwork: string;
}

export interface ContainerInspection {
  Image: string;
  Config: { Env: string[] };
  HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; PidMode: string; IpcMode: string; CapAdd: string[] | null; CapDrop: string[] | null; SecurityOpt: string[] | null; PortBindings: Record<string, unknown> | null; ExtraHosts: string[] | null; Devices: unknown[] | null };
  NetworkSettings: { Networks: Record<string, unknown> };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
}

/** Validate daemon-observed confinement, returning no environment values or host paths. */
export function containerIsolationFacts(info: ContainerInspection, expected: {
  image: string; networks: string[]; envNames: string[];
  mounts: Array<{ source: string; destination: string; writable: boolean }>;
}) {
  const deny = (): never => { throw new Error("Docker isolation inspection failed"); };
  const networks = Object.keys(info.NetworkSettings.Networks).sort();
  const envNames = info.Config.Env.map(entry => entry.split("=", 1)[0]!).sort();
  const host = info.HostConfig;
  if (info.Image !== expected.image || networks.join() !== [...expected.networks].sort().join() ||
      host.NetworkMode === "host" || !host.ReadonlyRootfs || host.Privileged || host.PidMode === "host" || host.IpcMode === "host" ||
      (host.CapAdd?.length ?? 0) > 0 || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.some(option => option === "no-new-privileges" || option === "no-new-privileges=true") ||
      Object.keys(host.PortBindings ?? {}).length > 0 || (host.ExtraHosts?.length ?? 0) > 0 || (host.Devices?.length ?? 0) > 0 ||
      envNames.some(name => !expected.envNames.includes(name)) || info.Mounts.length !== expected.mounts.length) deny();
  for (const mount of info.Mounts) {
    if (mount.Type !== "bind" || !expected.mounts.some(item => item.source === mount.Source && item.destination === mount.Destination && item.writable === mount.RW)) deny();
  }
  return { image: info.Image, networks, environment_names: envNames, mounts: info.Mounts.map(mount => ({ destination: mount.Destination, writable: mount.RW })), read_only_root: true, host_network: false, privileged: false, added_capabilities: false, published_ports: false, confinement_verified: true };
}

function dockerName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return normalized.slice(0, 54) || "dal-e2e";
}

export function topologyFor(attemptId: string): DockerTopology {
  const id = `${dockerName(`dal-e2e-${attemptId}`).slice(0, 35)}-${createHash("sha256").update(attemptId).digest("hex").slice(0, 16)}`;
  return {
    id,
    candidateNetwork: `${id}-candidate`,
    graderNetwork: `${id}-grader`,
    serviceContainer: `${id}-service`,
    candidateContainer: `${id}-candidate`,
    graderContainer: `${id}-grader`,
    gatewayContainer: `${id}-gateway`,
    outboundNetwork: `${id}-outbound`,
  };
}

export async function stageCandidateWorkspace(options: {
  stageRoot: string;
  taskId: string;
  agentTask: unknown;
  compositionPatch: string;
  skillPath: string;
  policyPath: string;
}): Promise<void> {
  const taskDir = join(options.stageRoot, ".dal", "benchmark", "e2e");
  const skillDir = join(options.stageRoot, ".agents", "skills", "refund-workflow");
  const policyDir = join(options.stageRoot, "tasks");
  await Promise.all([
    mkdir(taskDir, { recursive: true, mode: 0o700 }),
    mkdir(skillDir, { recursive: true, mode: 0o700 }),
    mkdir(policyDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(taskDir, `agent-task-${options.taskId}.json`), `${JSON.stringify(options.agentTask, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(taskDir, "model-patch.yml"), options.compositionPatch, { mode: 0o600 }),
    copyFile(options.skillPath, join(skillDir, "SKILL.md")),
    copyFile(options.policyPath, join(policyDir, "policy.md")),
  ]);
}

export function serviceDockerArgv(options: {
  image: string;
  topology: DockerTopology;
  stateRootHost: string;
}): string[] {
  return [
    "run",
    "--detach",
    "--name",
    options.topology.serviceContainer,
    "--label",
    `dal.e2e.attempt=${options.topology.id}`,
    "--network",
    options.topology.candidateNetwork,
    "--network-alias",
    SERVICE_ALIAS,
    "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${options.stateRootHost},dst=/service-state`,
    "-e",
    "DAL_SERVICE_STATE_ROOT=/service-state",
    "-e",
    `DAL_SERVICE_PORT=${SERVICE_PORT}`,
    "-e",
    "DAL_SERVICE_FAULTS",
    "-e",
    "DAL_SERVICE_RESOLUTIONS",
    "-e",
    "DAL_EVALUATOR_TOKEN",
    options.image,
    "node",
    "/opt/dal/plugins/dal-workflow-tools/lib/server.js",
  ];
}

export function candidateDockerArgv(options: {
  image: string;
  topology: DockerTopology;
  stageRoot: string;
  dshHomeHost: string;
  keyEnv?: string;
  prompt: string;
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    options.topology.candidateContainer,
    "--label",
    `dal.e2e.attempt=${options.topology.id}`,
    "--network",
    options.topology.candidateNetwork,
    "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${options.stageRoot},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${options.dshHomeHost},dst=/dsh-home`,
    "-e",
    "DSH_HOME=/dsh-home",
    "-e",
    "DAL_GATEWAY_TOKEN",
    "-w",
    "/workspace",
    options.image,
    "node",
    "--expose-internals",
    "--import",
    "/opt/dal/dist/e2e-openai-text-replay-preload.js",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "--profile",
    "headless",
    "--patch",
    CONTAINER_PATCH_PATH,
    options.prompt,
  ];
}

export function networkDockerArgv(topology: DockerTopology, mode: "live" | "rehearsal"): string[][] {
  return [topology.candidateNetwork, topology.graderNetwork, ...(mode === "live" ? [topology.outboundNetwork] : [])].map(name => [
    "network", "create", "--label", `dal.e2e.attempt=${topology.id}`,
    ...(name === topology.outboundNetwork ? [] : ["--internal"]), name,
  ]);
}

export function gatewayDockerArgv(options: {
  image: string; topology: DockerTopology; policyPath: string; ledgerRoot: string;
  mode: "live" | "rehearsal"; provider: "openai" | "anthropic";
}): string[] {
  return ["run", "--detach", "--name", options.topology.gatewayContainer,
    "--label", `dal.e2e.attempt=${options.topology.id}`,
    "--network", options.topology.candidateNetwork, "--network-alias", "dal-model-gateway",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--mount", `type=bind,src=${options.policyPath},dst=/gateway-policy.json,readonly`,
    "--mount", `type=bind,src=${options.ledgerRoot},dst=/gateway-ledger`,
    "-e", "DAL_GATEWAY_POLICY=/gateway-policy.json", "-e", "DAL_GATEWAY_LEDGER_ROOT=/gateway-ledger",
    "-e", `DAL_GATEWAY_MODE=${options.mode}`, "-e", "DAL_GATEWAY_TOKEN",
    ...(options.mode === "live" ? ["-e", options.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"] : []),
    options.image, "node", "/opt/dal/dist/e2e-model-gateway.js"];
}

export function graderDockerArgv(options: {
  image: string;
  topology: DockerTopology;
  taskPath: string;
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    options.topology.graderContainer,
    "--label",
    `dal.e2e.attempt=${options.topology.id}`,
    "--network",
    options.topology.graderNetwork,
    "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${options.taskPath},dst=/oracle/task.json,readonly`,
    "-e",
    "DAL_EVALUATOR_TOKEN",
    options.image,
    "node",
    "/opt/dal/dist/workflow-grader-remote.js",
    "/oracle/task.json",
    `${SERVICE_URL}/v1/evaluator/snapshot`,
  ];
}
