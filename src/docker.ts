import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { DalError } from "./errors.js";

/**
 * Container-hosted harness execution: the docker runner re-executes the same
 * fail-closed dal path inside a pinned dsh container. The workspace is
 * bind-mounted at /workspace, networking is disabled by construction
 * (`--network none` is hardcoded), and the in-container sandbox seam
 * (bwrap -> Landlock) remains the enforcement boundary. Build and probe
 * instructions live in deploy/docker/README.md.
 */

export interface DockerRunnerOptions {
  image: string;
  runFlags: string[];
  envNames: string[];
  workspaceRoot: string;
  /** `none` disables container networking (verifier posture); `default` allows model-API egress (propose). */
  network: "none" | "default";
}

/** Probe the docker daemon; false when the CLI or daemon is unavailable. */
export function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return probe.error === undefined && probe.status === 0 && probe.stdout.trim() !== "";
}

export function assertDockerAvailable(): void {
  if (!dockerAvailable()) {
    throw new DalError(
      "DOCKER_UNAVAILABLE",
      "docker is not reachable; the docker runner requires a running docker daemon (see deploy/docker/README.md)",
    );
  }
}

/**
 * Map a host path inside the workspace to its container location. Fails
 * closed when the path escapes the workspace root: the container only sees
 * the workspace mount.
 */
export function containerPath(hostPath: string, workspaceRoot: string): string {
  const absolute = resolve(hostPath);
  const root = resolve(workspaceRoot);
  const rel = relative(root, absolute);
  if (rel === "") {
    return "/workspace";
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DalError("DOCKER_PATH_DENIED", `Path escapes the workspace mount: ${hostPath}`);
  }
  return `/workspace/${rel.split(sep).join("/")}`;
}

/** Rewrite workspace-root host paths inside a command line to container paths. */
export function translateCommandForContainer(commandLine: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const translated = tokens.map((token) => {
    const quoted = token.length >= 2 && (token.startsWith('"') || token.startsWith("'")) && token.endsWith(token[0]!);
    const value = quoted ? token.slice(1, -1) : token;
    const absolute = resolve(value);
    if (!isAbsolute(value) || !absolute.startsWith(root)) {
      return token;
    }
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new DalError("DOCKER_PATH_DENIED", `Command path escapes the workspace mount: ${value}`);
    }
    return `${token[0] === '"' ? '"' : token[0] === "'" ? "'" : ""}${containerPath(value, root)}${quoted ? token[0]! : ""}`;
  });
  return translated.join(" ");
}

/** The argv for one `docker run` execution of a command in the workspace. */
export function dockerRunArgv(options: DockerRunnerOptions, command: readonly string[]): string[] {
  const dotEnv = loadDotEnv(options.workspaceRoot);
  const envArgs: string[] = [];
  for (const name of options.envNames) {
    const hostValue = process.env[name];
    if (hostValue !== undefined) {
      envArgs.push("-e", name);
      continue;
    }
    const dotValue = dotEnv[name];
    if (dotValue !== undefined) {
      envArgs.push("-e", `${name}=${dotValue}`);
    }
  }
  return [
    "run",
    "--rm",
    ...(options.network === "none" ? ["--network", "none"] : []),
    ...options.runFlags,
    "-v",
    `${resolve(options.workspaceRoot)}:/workspace`,
    "-w",
    "/workspace",
    ...envArgs,
    options.image,
    ...command,
  ];
}

/**
 * Parse the workspace-root `.env` file (KEY=VALUE lines, `export` prefix,
 * comments, and single/double quotes supported). Missing or unreadable files
 * yield an empty map. Values never enter error messages or logs.
 */
export function loadDotEnv(workspaceRoot: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(resolve(workspaceRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equals = body.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = body.slice(0, equals).trim();
    let value = body.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") {
      values[key] = value;
    }
  }
  return values;
}

export interface DockerRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run one container command and return its captured result. */
export function runDocker(options: DockerRunnerOptions, command: readonly string[], timeoutMs: number): DockerRunResult {
  const argv = dockerRunArgv(options, command);
  const result = spawnSync("docker", argv, {
    cwd: options.workspaceRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new DalError("DOCKER_RUN_FAILED", `docker run failed to start: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new DalError("DOCKER_RUN_FAILED", `docker run exceeded its budget and was terminated (${result.signal})`);
  }
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}
