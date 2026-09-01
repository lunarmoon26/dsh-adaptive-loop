import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
}

function dockerName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return normalized.slice(0, 54) || "dal-e2e";
}

export function topologyFor(attemptId: string): DockerTopology {
  const id = dockerName(`dal-e2e-${attemptId}`);
  return {
    id,
    candidateNetwork: `${id}-candidate`,
    graderNetwork: `${id}-grader`,
    serviceContainer: `${id}-service`,
    candidateContainer: `${id}-candidate`,
    graderContainer: `${id}-grader`,
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
  keyEnv: string;
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
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${options.stageRoot},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${options.dshHomeHost},dst=/dsh-home`,
    "-e",
    "DSH_HOME=/dsh-home",
    "-e",
    options.keyEnv,
    "-w",
    "/workspace",
    options.image,
    "dsh",
    "--profile",
    "headless",
    "--patch",
    CONTAINER_PATCH_PATH,
    options.prompt,
  ];
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
