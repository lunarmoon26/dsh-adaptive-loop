import { basename } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { SandboxUnavailableError, type ConfinedArgv, type SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";

import { DalError } from "./errors.js";

/**
 * Axis-b sandbox backend: dal consumes the dsh sandbox seam
 * (`@deepseek-ai/dsh-sandbox` + `dsh-sandbox-local`) instead of owning
 * platform profiles. The provider selects the platform runner (Seatbelt on
 * macOS, bwrap then Landlock on Linux, ACL runner on Windows) and fails
 * closed with SANDBOX_UNAVAILABLE when none works.
 */

export interface BackendConfinement {
  argv: string[];
  backend: string;
  enforcement: "full" | "partial";
  denialSignatures: readonly string[];
  runnerFailureRules: ConfinedArgv["runnerFailureRules"];
}

let contextPromise: Promise<Context> | undefined;

async function sandboxContext(): Promise<Context> {
  if (contextPromise !== undefined) {
    return contextPromise;
  }
  contextPromise = (async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSandboxProvider);
    return ctx;
  })();
  return contextPromise;
}

export type ConfineFn = (argv: string[], policy: SandboxPolicy) => Promise<BackendConfinement>;

export async function confine(argv: string[], policy: SandboxPolicy): Promise<BackendConfinement> {
  const ctx = await sandboxContext();
  let confined: ConfinedArgv;
  try {
    confined = ctx.sandbox.confine(argv, policy);
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      throw new DalError("SANDBOX_UNAVAILABLE", error.message);
    }
    throw error;
  }
  if (confined.argv.length === 0) {
    throw new DalError("SANDBOX_UNAVAILABLE", "Sandbox backend returned an empty confined argv");
  }
  return {
    argv: confined.argv,
    backend: basename(confined.argv[0] ?? "unknown"),
    enforcement: confined.enforcement,
    denialSignatures: confined.denialSignatures,
    runnerFailureRules: confined.runnerFailureRules,
  };
}
