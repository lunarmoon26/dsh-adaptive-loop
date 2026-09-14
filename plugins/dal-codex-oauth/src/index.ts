import type { Context } from "@deepseek-ai/cordis";
import { terminalIo } from "./terminal.js";
import type { Authorization, BootstrapIo } from "./types.js";
import { verifyLoginApproval } from "./approval.js";
import type { ApprovalConfig } from "./approval.js";

export const name = "dal-codex-oauth";
export const inject = ["authorization"];
export const CODEX_KEY = "llm-pi-ai/openai-codex";

export interface Config extends ApprovalConfig { timeoutMs?: number }

export function resolveTimeout(config: Config): number {
  const value = config.timeoutMs ?? 300_000;
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error("dal-codex-oauth timeoutMs must be an integer between 1000 and 600000");
  }
  return value;
}

/** No CLI argument can change the provider, method or credential destination. */
export async function runBootstrap(auth: Authorization, args: readonly string[], io: BootstrapIo,
                                   controller: AbortController, timeoutMs: number,
                                   verifyLogin?: () => Promise<void>): Promise<number> {
  if (args.length !== 1 || !["--oauth-check", "--oauth-login", "--help"].includes(args[0]!)) {
    io.write("Usage: dsh --profile <profile> --patch <bootstrap.patch.yml> --oauth-check|--oauth-login|--help");
    return 2;
  }
  if (args[0] === "--help") {
    io.write("--oauth-check: verify native flow only. --oauth-login: interactive Codex subscription OAuth, no model calls.");
    return 0;
  }
  const flow = auth.describe(CODEX_KEY);
  if (!flow?.methods.some(method => method.id === "oauth")) {
    io.write("DAL_CODEX_OAUTH_NO_NATIVE_FLOW");
    return 1;
  }
  if (args[0] === "--oauth-check") {
    io.write("DAL_CODEX_OAUTH_READY: native flow registered; subscription authentication has NOT been checked.");
    return 0;
  }
  if (!io.interactive) {
    io.write("DAL_CODEX_OAUTH_TTY_REQUIRED: run directly in your own terminal; do not pipe or redirect login.");
    return 2;
  }
  if (flow.inFlight) {
    io.write("DAL_CODEX_OAUTH_BUSY");
    return 1;
  }
  if (controller.signal.aborted) return 130;
  try {
    if (!verifyLogin) throw new Error("OAUTH_APPROVAL_REQUIRED");
    await verifyLogin();
  } catch {
    io.write("DAL_CODEX_OAUTH_APPROVAL_REQUIRED: missing, invalid, expired or drifted approval; login was not started.");
    return 1;
  }
  if (controller.signal.aborted) return 130;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const outcome = await auth.begin({ key: CODEX_KEY, method: "oauth", signal: controller.signal,
      interaction: io.interaction(controller.signal, () => controller.abort()) });
    if (outcome.status === "authorized" && !controller.signal.aborted) {
      io.write("DAL_CODEX_OAUTH_AUTHORIZED: DSH confirmed a committed grant; no credential contents were displayed.");
      return 0;
    }
    io.write(timedOut ? "DAL_CODEX_OAUTH_TIMEOUT" : "DAL_CODEX_OAUTH_CANCELLED");
    return timedOut ? 124 : 130;
  } catch {
    // Provider exceptions can contain token/response material. Never stringify.
    io.write(timedOut ? "DAL_CODEX_OAUTH_TIMEOUT" : controller.signal.aborted
      ? "DAL_CODEX_OAUTH_CANCELLED" : "DAL_CODEX_OAUTH_FAILED: native login failed; no provider error details were logged.");
    return timedOut ? 124 : controller.signal.aborted ? 130 : 1;
  } finally {
    clearTimeout(timer);
  }
}

/** The small, version-pinned launcher service surface used at this boundary. */
interface Host {
  get(name: string): unknown;
  effect(callback: () => () => void): unknown;
}

export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = resolveTimeout(config);
  const host = ctx as unknown as Host;
  const auth = host.get("authorization") as Authorization | undefined;
  const ready = host.get("appReady") as { onReady(callback: () => void): () => void } | undefined;
  const exit = host.get("appExit") as ((code: number) => void) | undefined;
  const command = host.get("cmdlineArgs") as { get(): readonly string[] } | undefined;
  if (!auth || !ready || !exit || !command) {
    throw new Error("dal-codex-oauth requires native authorization and the supported DSH launcher readiness/exit services");
  }
  host.effect(() => {
    const controller = new AbortController();
    const io = terminalIo();
    let disposed = false;
    const off = ready.onReady(() => {
      void runBootstrap(auth, command.get(), io, controller, timeoutMs, () => verifyLoginApproval(config)).then(code => {
        if (!disposed) exit(code);
      }).catch(() => {
        if (!disposed) { io.write("DAL_CODEX_OAUTH_STARTUP_FAILED"); exit(1); }
      });
    });
    return () => { disposed = true; off(); controller.abort(); };
  });
}
