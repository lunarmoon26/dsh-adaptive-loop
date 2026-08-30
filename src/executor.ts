import { spawnSync } from "node:child_process";

import type { SandboxPolicy } from "@deepseek-ai/dsh-sandbox";

import { assertDockerAvailable, containerPath, runDocker, translateCommandForContainer } from "./docker.js";
import { DalError } from "./errors.js";
import { readJsonFile } from "./json.js";
import { evaluateGuardrailAction, validateGuardrailAction } from "./guardrail.js";
import { confine, type ConfineFn } from "./sandbox-backend.js";

export interface SandboxReport {
  backend: string;
  enforcement: "full" | "partial";
  profile_applied: boolean;
}

export interface VerifierRunResult {
  exit_code: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  sandbox: SandboxReport;
}

export interface VerifierDockerOptions {
  image: string;
  runFlags: string[];
  envNames: string[];
}

export async function runVerifier(options: {
  actionPath: string;
  commandLine: string;
  workspaceRoot: string;
  confineFn?: ConfineFn;
  runner?: "local" | "docker";
  docker?: VerifierDockerOptions;
}): Promise<VerifierRunResult> {
  const document = await readJsonFile<unknown>(options.actionPath);
  const action = await validateGuardrailAction(document.value, document.raw.toString("utf8"));
  if (action.capability !== "run_local_verifier") {
    throw new DalError("VERIFIER_DENIED", "Only run_local_verifier actions may execute");
  }
  const decision = await evaluateGuardrailAction(action);
  if (decision.effect !== "allowed") {
    throw new DalError("VERIFIER_DENIED", `Guardrail effect is ${decision.effect}; the decision must be allowed at the operation`);
  }
  if (action.sandbox.mode === "none") {
    throw new DalError("VERIFIER_DENIED", "A sandbox declaration is required; refusing unconfined execution");
  }
  if (action.sandbox.network !== "denied") {
    throw new DalError("VERIFIER_DENIED", "Network must be declared denied; refusing");
  }

  if (options.runner === "docker") {
    return runVerifierInDocker({
      actionPath: options.actionPath,
      commandLine: options.commandLine,
      workspaceRoot: options.workspaceRoot,
      docker: options.docker ?? { image: "dsh-adaptive-loop/dsh:0.1.1-rc.2", runFlags: [], envNames: [] },
      budgetMs: action.budget.max_duration_ms,
    });
  }

  const parsedLine = parseCommandLine(options.commandLine);
  const command = parsedLine[0]!;
  const args = parsedLine.slice(1);
  const policy: SandboxPolicy = {
    mode: action.sandbox.mode === "read_only" ? "read-only" : "workspace-write",
    workspaceRoot: options.workspaceRoot,
  };
  const confineFn = options.confineFn ?? confine;
  const confinement = await confineFn([command, ...args], policy);

  const result = spawnSync(confinement.argv[0]!, confinement.argv.slice(1), {
    cwd: options.workspaceRoot,
    encoding: "utf8",
    timeout: Math.min(action.budget.max_duration_ms, 300000),
    maxBuffer: Math.min(action.budget.max_bytes_read, 16 * 1024 * 1024),
  });
  if (result.error !== undefined) {
    throw new DalError("VERIFIER_FAILED", `Verifier spawn failed: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new DalError("VERIFIER_FAILED", `Verifier exceeded its budget and was terminated (${result.signal})`);
  }
  const stdout = String(result.stdout ?? "").slice(0, action.budget.max_bytes_read);
  const stderr = String(result.stderr ?? "").slice(0, 65536);
  return {
    exit_code: result.status ?? 1,
    passed: result.status === 0,
    stdout,
    stderr,
    sandbox: {
      backend: confinement.backend,
      enforcement: confinement.enforcement,
      profile_applied: true,
    },
  };
}

/**
 * Docker runner: the same fail-closed dal verify path re-executes INSIDE the
 * pinned container. The guardrail decision above was already verified on the
 * host; the in-container CLI re-validates it at the operation, and the
 * in-container sandbox seam (bwrap -> Landlock) is the enforcement boundary.
 * `--network none` and the workspace-only mount are hardcoded by the runner.
 */
async function runVerifierInDocker(options: {
  actionPath: string;
  commandLine: string;
  workspaceRoot: string;
  docker: VerifierDockerOptions;
  budgetMs: number;
}): Promise<VerifierRunResult> {
  assertDockerAvailable();
  const action = containerPath(options.actionPath, options.workspaceRoot);
  const commandLine = translateCommandForContainer(options.commandLine, options.workspaceRoot);
  const result = runDocker(
    {
      image: options.docker.image,
      runFlags: options.docker.runFlags,
      envNames: options.docker.envNames,
      workspaceRoot: options.workspaceRoot,
      network: "none",
    },
    ["node", "/opt/dal/dist/cli.js", "verify", "run", "--action", action, "--command", commandLine, "--workspace", "/workspace"],
    Math.min(options.budgetMs, 300000) + 60_000,
  );
  if (result.status !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new DalError(
      "VERIFIER_FAILED",
      `In-container verifier exited ${result.status}${tail === "" ? "" : `: ${tail}`}`,
    );
  }
  let inner: { status: string; exit_code: number; sandbox: SandboxReport };
  try {
    inner = JSON.parse(result.stdout) as typeof inner;
  } catch {
    throw new DalError("DOCKER_RUN_FAILED", `In-container verifier returned no parseable result: ${result.stdout.slice(-500)}`);
  }
  return {
    exit_code: inner.exit_code,
    passed: inner.status === "passed",
    stdout: result.stdout,
    stderr: result.stderr,
    sandbox: inner.sandbox,
  };
}

function parseCommandLine(commandLine: string): string[] {
  const tokens = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (tokens === null || tokens.length === 0) {
    throw new DalError("VERIFIER_DENIED", "Empty command line");
  }
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
}
