import { describe, expect, it, vi } from "vitest";
import { ToolRuntime, type ToolExecutionInput, type ToolExecutionResult, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { bindNativeDispatch, createNativeFusionAdapter, NATIVE_ADAPTER_BLOCKERS,
  NATIVE_ADAPTER_TARGET } from "../prototypes/action-fusion/native-adapter.js";
import type { ChildCall } from "../prototypes/action-fusion/core.js";

const id = "01234567-89ab-4cde-8fab-0123456789ab";
const request = () => ({ mutation: { name: "edit", arguments: {
  file_path: "./synthetic.py", old_string: "old", new_string: "new",
} }, command: { command: "synthetic-check", description: "synthetic", workdir: ".", timeoutMs: 1000 } });
function fixture() {
  const abort = new AbortController();
  const nativeResult: ToolExecutionResult = {
    isError: false, value: { exitCode: 0, stdout: { text: "bounded", truncated: true, spillPath: "private-ref" } },
    content: [{ type: "text", text: "bounded" }], meta: { privateReference: "fixture-ref" },
  };
  // Typed service doubles only. No Cordis plugin, session or native policy pipeline is mounted.
  const tools = Object.create(ToolRuntime.prototype) as ToolRuntime;
  const execute = vi.fn(async function (this: ToolRuntime, _input: ToolExecutionInput): Promise<ToolExecutionResult> {
    expect(this).toBe(tools);
    return nativeResult;
  });
  tools.execute = execute;
  class Parent {
    callId = "root-call"; rootCallId = "root-call"; token = Symbol("native-parent");
    agent = { session: { id: "synthetic-session" } }; signal = abort.signal;
    contexts: unknown[] = []; ended = false;
    deferContext(value: unknown) { this.contexts.push(value); }
    concludeTurn() { this.ended = true; }
  }
  const parentFixture = new Parent();
  // Brands and Agent instances are deliberately synthetic; never runtime-generation evidence.
  const parent = parentFixture as unknown as ToolRunContext;
  const call = (): ChildCall => ({ callId: `${id}:mutation`, rootCallId: parent.rootCallId,
    parent: parent.token, agent: parent.agent!, signal: new AbortController().signal,
    name: "edit", arguments: Object.freeze({ file_path: "./synthetic.py", old_string: "old", new_string: "new" }) });
  return { tools, execute, parent, parentFixture, abort, nativeResult, call };
}

describe("inactive native binding: real exported types, synthetic services, no mounting", () => {
  it("imports the installed native dispatcher export without constructing a service", () => {
    expect(typeof ToolRuntime.prototype.execute).toBe("function");
    expect(NATIVE_ADAPTER_TARGET).toBe("@deepseek-ai/dsh-tools@0.1.1-rc.2");
  });
  it("defaults disabled without even requiring a parent context", async () => {
    const f = fixture();
    const adapter = createNativeFusionAdapter(f.tools);
    expect(await adapter.run(request(), undefined as unknown as ToolRunContext)).toMatchObject({
      status: "disabled", code: "DISABLED", effects: "none_dispatched", evidenceRefs: [],
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("explicit enable cannot bypass native evidence blockers", async () => {
    const f = fixture();
    const adapter = createNativeFusionAdapter(f.tools, { enabled: true });
    expect(await adapter.run(request(), f.parent)).toMatchObject({
      status: "blocked", code: "NATIVE_EVIDENCE_UNAVAILABLE", effects: "none_dispatched", evidenceRefs: [],
    });
    expect(adapter.blockers).toEqual(NATIVE_ADAPTER_BLOCKERS);
    expect(Object.isFrozen(adapter.blockers)).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("has no injected readiness or evidence callback escape", async () => {
    const f = fixture();
    const callback = vi.fn();
    const options = { enabled: true, assertReady: callback, record: callback };
    const adapter = createNativeFusionAdapter(f.tools, options);
    expect((await adapter.run(request(), f.parent)).code).toBe("NATIVE_EVIDENCE_UNAVAILABLE");
    expect(callback).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects malformed input before readiness and dispatch", async () => {
    const f = fixture();
    expect((await createNativeFusionAdapter(f.tools, { enabled: true }).run({}, f.parent)).code).toBe("INVALID_INPUT");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("retains cancellation with no evidence or side effects", async () => {
    const f = fixture();
    f.abort.abort();
    expect((await createNativeFusionAdapter(f.tools, { enabled: true }).run(request(), f.parent)).status).toBe("cancelled");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([0, 60_001, NaN, 1.5])("rejects invalid overall timeout %s", timeoutMs => {
    expect(() => createNativeFusionAdapter(fixture().tools, { timeoutMs })).toThrow("INVALID_INPUT");
  });
  it("requires a native agent before binding", () => {
    const f = fixture();
    expect(() => bindNativeDispatch(f.tools, { ...f.parent, agent: undefined } as unknown as ToolRunContext))
      .toThrow("NATIVE_AGENT_REQUIRED");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["edit", "write", "bash"] as const)("routes %s through tools.execute with native parent identity and receiver", async name => {
    const f = fixture();
    const binding = bindNativeDispatch(f.tools, f.parent);
    const call = { ...f.call(), name, callId: `${id}:${name === "bash" ? "command" : "mutation"}` };
    const result = await binding.dispatch(call);
    expect(result).toBe(f.nativeResult);
    const received = f.execute.mock.calls[0]![0];
    expect(received).toMatchObject({ callId: call.callId, rootCallId: f.parent.rootCallId, name });
    expect(received.parent).toBe(f.parent.token);
    expect(received.agent).toBe(f.parent.agent);
    expect(received.arguments).toBe(call.arguments);
  });
  it("retains a native error payload rather than fabricating an error DTO", async () => {
    const f = fixture();
    const error: ToolExecutionResult = { isError: true, error: { message: "synthetic denial",
      info: { name: "PolicyDenied", code: "POLICY_DENIED" } }, content: [] };
    f.execute.mockResolvedValueOnce(error);
    expect(await bindNativeDispatch(f.tools, f.parent).dispatch(f.call())).toBe(error);
  });
  it.each(["agent", "parent", "rootCallId"])("rejects child %s substitution", async field => {
    const f = fixture();
    const changed = { ...f.call(), [field]: field === "parent" ? Symbol() : field === "agent" ? {} : "other-root" };
    await expect(bindNativeDispatch(f.tools, f.parent).dispatch(changed)).rejects.toThrow("NATIVE_PARENT_MISMATCH");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["read", "run_code", "fusion", "spawn"])("rejects non-leaf target %s", name => {
    const f = fixture();
    return expect(bindNativeDispatch(f.tools, f.parent).dispatch({ ...f.call(), name } as ChildCall))
      .rejects.toThrow("NATIVE_LEAF_REJECTED");
  });
  it.each(["parent", `${id}:command`, "../mutation", "not-a-uuid:mutation"])("rejects invalid mutation child identity %s", callId => {
    const f = fixture();
    return expect(bindNativeDispatch(f.tools, f.parent).dispatch({ ...f.call(), callId }))
      .rejects.toThrow("NATIVE_CHILD_ID_INVALID");
  });
  it("captures original parent identity and bound context method receivers", () => {
    const f = fixture();
    const binding = bindNativeDispatch(f.tools, f.parent);
    f.parentFixture.rootCallId = "changed";
    binding.context.deferContext({ role: "user", content: [{ type: "text", text: "fixture" }] });
    binding.context.concludeTurn();
    expect(binding.context.rootCallId).toBe("root-call");
    expect(f.parentFixture.contexts).toHaveLength(1);
    expect(f.parentFixture.ended).toBe(true);
  });
  it.each(["parent", "child"])("honors %s cancellation before dispatch", async which => {
    const f = fixture();
    const child = new AbortController();
    if (which === "parent") f.abort.abort(); else child.abort();
    await expect(bindNativeDispatch(f.tools, f.parent).dispatch({ ...f.call(), signal: child.signal }))
      .rejects.toThrow("NATIVE_CANCELLED_BEFORE_DISPATCH");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("propagates parent cancellation into an already dispatched child's signal", async () => {
    const f = fixture();
    await bindNativeDispatch(f.tools, f.parent).dispatch(f.call());
    const signal = f.execute.mock.calls[0]![0].signal;
    expect(signal.aborted).toBe(false);
    f.abort.abort();
    expect(signal.aborted).toBe(true);
  });
  it("does not retry native dispatch exceptions", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await expect(bindNativeDispatch(f.tools, f.parent).dispatch(f.call())).rejects.toThrow("synthetic transport failure");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
