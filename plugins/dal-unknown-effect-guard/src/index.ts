import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";

/**
 * G2 candidate guard for uncertain workflow effects.
 *
 * State is scoped to the calling agent object. A side-effect call claims its
 * idempotency key before dispatch; an `unknown` result keeps that key locked.
 * Only a successful `get_effect_status` call reporting `success` or
 * `definite_failure` releases it. The plugin stores no arguments or results.
 *
 * This package ships disabled. Mounting it and applying it as an optimization
 * candidate remain separate approval-gated operations.
 */

export const name = "dal-unknown-effect-guard";
export const inject: string[] = [];

const EFFECT_TOOLS = new Set(["issue_refund", "create_return_label", "change_booking", "refuse_request"]);
const TERMINAL_OUTCOMES = new Set(["success", "definite_failure"]);

interface KeyLock {
  callId: string;
  tool: string;
  state: "in_flight" | "unknown";
}

interface AgentState {
  locks: Map<string, KeyLock>;
  calls: Map<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function idempotencyKey(exec: Readonly<ToolExecution>): string | undefined {
  const value = record(exec.arguments)?.idempotency_key;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export class UnknownEffectGuard {
  private readonly agents = new WeakMap<object, AgentState>();

  private state(exec: Readonly<ToolExecution>): AgentState | undefined {
    if (exec.agent === undefined) return undefined;
    const owner = exec.agent as object;
    const existing = this.agents.get(owner);
    if (existing !== undefined) return existing;
    const created: AgentState = { locks: new Map(), calls: new Map() };
    this.agents.set(owner, created);
    return created;
  }

  async preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (!EFFECT_TOOLS.has(exec.name)) return next();
    const key = idempotencyKey(exec);
    const state = this.state(exec);
    if (key === undefined || state === undefined) return next();

    const existing = state.locks.get(key);
    if (existing !== undefined && existing.callId !== String(exec.callId)) {
      return {
        kind: "deny",
        reason: `Effect key ${key} is ${existing.state}; call get_effect_status for that idempotency key before retrying`,
      };
    }

    const callId = String(exec.callId);
    state.locks.set(key, { callId, tool: exec.name, state: "in_flight" });
    state.calls.set(callId, key);
    try {
      const decision = await next();
      if (decision.kind === "deny") this.releaseCall(state, callId);
      return decision;
    } catch (error) {
      this.releaseCall(state, callId);
      throw error;
    }
  }

  observeResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const state = this.state(exec);
    if (state === undefined) return;

    if (exec.name === "get_effect_status") {
      const key = idempotencyKey(exec);
      const value = result.isError ? undefined : record(result.value);
      if (key !== undefined && value?.found === true && TERMINAL_OUTCOMES.has(String(value.outcome))) {
        state.locks.delete(key);
      }
      return;
    }

    if (!EFFECT_TOOLS.has(exec.name)) return;
    const callId = String(exec.callId);
    const key = state.calls.get(callId) ?? idempotencyKey(exec);
    if (key === undefined) return;
    state.calls.delete(callId);
    const existing = state.locks.get(key);
    if (existing !== undefined && existing.callId !== callId) return;
    const value = result.isError ? undefined : record(result.value);
    if (!result.isError && TERMINAL_OUTCOMES.has(String(value?.outcome))) {
      state.locks.delete(key);
    } else {
      state.locks.set(key, { callId, tool: exec.name, state: "unknown" });
    }
  }

  private releaseCall(state: AgentState, callId: string): void {
    const key = state.calls.get(callId);
    state.calls.delete(callId);
    if (key !== undefined && state.locks.get(key)?.callId === callId) state.locks.delete(key);
  }
}

interface EventWiringContext {
  on(name: string, listener: (...args: never[]) => unknown): unknown;
}

export function apply(ctx: Context): void {
  const guard = new UnknownEffectGuard();
  const wiring = ctx as unknown as EventWiringContext;
  wiring.on("tools/pre-execute", (exec: ToolExecution, next: () => Promise<PreToolDecision>) =>
    guard.preExecute(exec, next));
  wiring.on("tools/result", (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    guard.observeResult(exec, result);
  });
}
