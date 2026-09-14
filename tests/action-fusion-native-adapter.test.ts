import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ToolRuntime, type ToolExecutionInput, type ToolExecutionResult, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { bindNativeDispatch, createNativeFusionAdapter, NATIVE_ADAPTER_BLOCKERS,
  NATIVE_ADAPTER_TARGET, NATIVE_CHILD_EVENT, type NativeEnvelope, type NativeEvidenceServices
} from "../prototypes/action-fusion/native-adapter.js";
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
  it("explicit enable without native services cannot bypass evidence checks", async () => {
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

// Fault injection only; the external DSH spec owns real native source evidence.
function checkpointFixture() {
  const f = fixture();
  const faults = { probe: false, append: 0, marker: false };
  class Session {
    seq = 0;
    events: NativeEnvelope[] = [];
    constructor(readonly id: string) {}
    static create(id: string) { return new Session(id); }
    append(type: string, data: unknown, options: { ignorable: true }) {
      if (this === live && faults.append === this.seq + 1) throw new Error("append failed");
      const event = Object.freeze({ type, data, seq: this.seq++,
        ...((this !== live && faults.probe) || (this === live && faults.marker) ? {} : options) });
      this.events.push(event);
      return event;
    }
  }
  const live = new Session("synthetic-live");
  f.parentFixture.agent.session = live;
  const checkpoint = vi.fn(async (session: never, seq: never, _options?: { signal?: AbortSignal }) => {
    expect(session).toBe(live);
    return { sessionId: live.id, throughSeq: seq as number, writerId: "writer-a" };
  });
  const native: NativeEvidenceServices = { Session, persistence: { bindLiveWriter: vi.fn(), checkpoint } };
  f.execute.mockImplementation(async () => ({ isError: false, content: [], value: {
    exitCode: 0, signal: null, aborted: false, timedOut: false, sandbox: { mode: "workspace-write", denied: false },
    stdout: { text: "bounded", truncated: true, spillPath: "private-ref" },
  } }));
  const adapter = createNativeFusionAdapter(f.tools, { enabled: true, native });
  return { ...f, faults, live, native, checkpoint, adapter };
}

describe("native checkpoint adapter faults (service doubles)", () => {
  it("rejects the actual installed legacy Session append on a disposable probe without polluting the parent", async () => {
    const require = createRequire(import.meta.url);
    const toolsRequire = createRequire(require.resolve("@deepseek-ai/dsh-tools"));
    const installed = await import(pathToFileURL(toolsRequire.resolve("@deepseek-ai/dsh-session")).href);
    const Session = installed.Session as NativeEvidenceServices["Session"];
    const f = checkpointFixture();
    const legacy = Session.create("legacy-parent" as never);
    f.parentFixture.agent.session = legacy;
    f.native.Session = Session;
    const before = legacy.seq;
    expect(await f.adapter.run(request(), f.parent)).toMatchObject({ status: "blocked", effects: "none_dispatched" });
    expect(legacy.seq).toBe(before);
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not probe or checkpoint supplied native services when disabled", async () => {
    const f = checkpointFixture();
    const probe = vi.spyOn(f.native.Session, "create");
    expect((await createNativeFusionAdapter(f.tools, { native: f.native }).run(request(), f.parent)).status).toBe("disabled");
    expect(probe).not.toHaveBeenCalled();
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.live.seq).toBe(0);
  });
  it("checkpoints exact parent prefix and each namespaced child envelope before advancing", async () => {
    const f = checkpointFixture();
    f.execute.mockImplementation(async input => {
      expect(f.checkpoint).toHaveBeenCalledTimes(input.name === "bash" ? 4 : 2);
      return { isError: false, content: [], value: { exitCode: 0, signal: null, aborted: false,
        timedOut: false, sandbox: { mode: "workspace-write", denied: false }, stdout: { spillPath: "private-ref" } } };
    });
    const result = await f.adapter.run(request(), f.parent);
    expect(result.status).toBe("succeeded");
    expect(result.evidenceRefs).toHaveLength(4);
    expect(f.checkpoint.mock.calls.map(call => call[1])).toEqual([-1, 0, 1, 2, 3]);
    expect(f.live.events.every(event => event.ignorable === true && event.type === NATIVE_CHILD_EVENT)).toBe(true);
    expect(f.native.persistence.bindLiveWriter).not.toHaveBeenCalled();
  });
  it.each(["old-abi", "probe", "foreign-class", "missing-writer"])("blocks %s without live-log pollution", async mode => {
    const f = checkpointFixture();
    if (mode === "old-abi") f.native.persistence.checkpoint = undefined as never;
    if (mode === "probe") f.faults.probe = true;
    if (mode === "foreign-class") f.native.Session = class Other {} as never;
    if (mode === "missing-writer") f.checkpoint.mockRejectedValue(new Error("missing live writer"));
    expect(await f.adapter.run(request(), f.parent)).toMatchObject({ status: "blocked", effects: "none_dispatched" });
    expect(f.live.events).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["session", "seq", "writer"])("rejects incorrect preflight %s acknowledgement", async field => {
    const f = checkpointFixture();
    f.checkpoint.mockResolvedValueOnce({ sessionId: field === "session" ? "other" : f.live.id,
      throughSeq: field === "seq" ? 0 : -1, writerId: field === "writer" ? "" : "writer-a" });
    expect((await f.adapter.run(request(), f.parent)).status).toBe("blocked");
    expect(f.live.events).toEqual([]);
  });
  it.each(["session", "seq", "writer"])("rejects changed settle %s acknowledgement and skips dispatching command", async field => {
    const f = checkpointFixture();
    f.checkpoint.mockImplementation(async (_session, seq) => ({
      sessionId: seq === 1 && field === "session" ? "other" : f.live.id,
      throughSeq: seq === 1 && field === "seq" ? 2 : seq,
      writerId: seq === 1 && field === "writer" ? "writer-b" : "writer-a",
    }));
    const result = await f.adapter.run(request(), f.parent);
    expect(result).toMatchObject({ status: "incomplete", effects: "possible" });
    expect(result.mutation).toBeDefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(result.evidenceRefs).toHaveLength(1);
  });
  it.each([1, 2, 3, 4])("append failure at event %s prevents further dispatch", async event => {
    const f = checkpointFixture();
    f.faults.append = event;
    expect((await f.adapter.run(request(), f.parent)).status).toBe("incomplete");
    expect(f.execute).toHaveBeenCalledTimes(Math.floor(event / 2));
  });
  it.each([0, 1, 2, 3])("checkpoint failure at event %s prevents further dispatch", async event => {
    const f = checkpointFixture();
    f.checkpoint.mockImplementation(async (_session, seq) => {
      if (seq === event) throw new Error("checkpoint failed");
      return { sessionId: f.live.id, throughSeq: seq, writerId: "writer-a" };
    });
    expect((await f.adapter.run(request(), f.parent)).status).toBe("incomplete");
    expect(f.execute).toHaveBeenCalledTimes(Math.floor((event + 1) / 2));
  });
  it("does not trust a live envelope missing its marker", async () => {
    const f = checkpointFixture();
    f.faults.marker = true;
    expect((await f.adapter.run(request(), f.parent)).status).toBe("incomplete");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
  });
  it("retains native denial info and contexts in settle evidence and records skipped command", async () => {
    const f = checkpointFixture();
    const denial = { isError: true, content: [], error: { message: "denied", info: { code: "DENIED" } },
      additionalContexts: [{ role: "user", content: [{ type: "text", text: "context" }] }] } as const;
    f.execute.mockResolvedValueOnce(denial as unknown as ToolExecutionResult);
    const result = await f.adapter.run(request(), f.parent);
    expect(result.status).toBe("failed");
    expect(result.mutation).toEqual(denial);
    expect(f.live.events[1]!.data).toMatchObject({ phase: "settle", result: denial });
    expect(f.live.events[2]!.data).toMatchObject({ phase: "skipped", operation: "bash" });
    expect(f.parentFixture.contexts).toEqual(denial.additionalContexts);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("propagates cancellation and awaits already dispatched work even if durable settlement fails", async () => {
    const f = checkpointFixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.execute.mockImplementationOnce(async input => {
      entered();
      await waiting;
      expect(input.signal.aborted).toBe(true);
      return { isError: true, content: [], error: { message: "cancelled", info: { name: "AbortError", code: "ABORTED" } } };
    });
    f.checkpoint.mockImplementation(async (_session, seq, options) => {
      options?.signal?.throwIfAborted();
      return { sessionId: f.live.id, throughSeq: seq, writerId: "writer-a" };
    });
    let settled = false;
    const pending = f.adapter.run(request(), f.parent).then(result => { settled = true; return result; });
    await started;
    f.abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await f.adapter.run(request(), f.parent)).status).toBe("busy");
    release();
    expect(await pending).toMatchObject({ status: "incomplete", effects: "possible", mutation: { isError: true } });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
