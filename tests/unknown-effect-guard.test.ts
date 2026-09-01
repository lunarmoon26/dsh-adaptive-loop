import type { PreToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";

import { UnknownEffectGuard, apply } from "../plugins/dal-unknown-effect-guard/src/index.js";

const allow = async (): Promise<PreToolDecision> => ({ kind: "allow" });

function execution(agent: object, name: string, key: string, callId: string): ToolExecution {
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: { idempotency_key: key },
    agent,
    signal: new AbortController().signal,
    token: Symbol(callId),
  } as unknown as ToolExecution;
}

function success(value: Record<string, unknown>): ToolExecutionResult {
  return { isError: false, value, content: [] } as ToolExecutionResult;
}

const failure = { isError: true, error: { message: "failed" }, content: [] } as ToolExecutionResult;

describe("G2 unknown-effect guard candidate", () => {
  it("blocks same-key retries until a terminal status result is observed", async () => {
    const guard = new UnknownEffectGuard();
    const agent = {};
    const first = execution(agent, "issue_refund", "refund-1", "call-1");
    expect(await guard.preExecute(first, allow)).toEqual({ kind: "allow" });
    guard.observeResult(first, success({ outcome: "unknown" }));

    const retry = execution(agent, "issue_refund", "refund-1", "call-2");
    await expect(guard.preExecute(retry, allow)).resolves.toMatchObject({ kind: "deny" });

    const pendingStatus = execution(agent, "get_effect_status", "refund-1", "status-1");
    guard.observeResult(pendingStatus, success({ found: true, outcome: "unknown" }));
    await expect(guard.preExecute(retry, allow)).resolves.toMatchObject({ kind: "deny" });

    const terminalStatus = execution(agent, "get_effect_status", "refund-1", "status-2");
    guard.observeResult(terminalStatus, success({ found: true, outcome: "success" }));
    await expect(guard.preExecute(retry, allow)).resolves.toEqual({ kind: "allow" });
  });

  it("blocks concurrent dispatch, releases terminal results, and retains errored calls", async () => {
    const guard = new UnknownEffectGuard();
    const agent = {};
    const first = execution(agent, "create_return_label", "label-1", "call-1");
    const concurrent = execution(agent, "create_return_label", "label-1", "call-2");
    expect(await guard.preExecute(first, allow)).toEqual({ kind: "allow" });
    await expect(guard.preExecute(concurrent, allow)).resolves.toMatchObject({ kind: "deny" });
    guard.observeResult(first, success({ outcome: "success" }));
    expect(await guard.preExecute(concurrent, allow)).toEqual({ kind: "allow" });
    guard.observeResult(concurrent, failure);
    const afterError = execution(agent, "create_return_label", "label-1", "call-3");
    await expect(guard.preExecute(afterError, allow)).resolves.toMatchObject({ kind: "deny" });
    guard.observeResult(execution(agent, "get_effect_status", "label-1", "status-1"), success({ found: true, outcome: "definite_failure" }));
    expect(await guard.preExecute(afterError, allow)).toEqual({ kind: "allow" });
  });

  it("never shares retry locks across agents", async () => {
    const guard = new UnknownEffectGuard();
    const first = execution({}, "change_booking", "booking-1", "call-1");
    expect(await guard.preExecute(first, allow)).toEqual({ kind: "allow" });
    guard.observeResult(first, success({ outcome: "unknown" }));
    expect(await guard.preExecute(execution({}, "change_booking", "booking-1", "call-2"), allow)).toEqual({ kind: "allow" });
  });

  it("registers only the enforcement and result-observation hooks", () => {
    const names: string[] = [];
    apply({ on(name: string) { names.push(name); } } as never);
    expect(names).toEqual(["tools/pre-execute", "tools/result"]);
  });
});
