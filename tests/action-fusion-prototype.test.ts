import { describe, expect, it, vi } from "vitest";
import { createFusionPrototype, type ChildCall, type Context, type DispatchResult,
  type Evidence, type Ports } from "../prototypes/action-fusion/core.js";

const edit = () => ({ mutation: { name: "edit", arguments: {
  file_path: "./candidate.py", old_string: "old", new_string: "new",
} }, command: { command: "check-candidate", description: "synthetic check", workdir: ".", timeoutMs: 1000 } });
const ok = (): DispatchResult => ({ isError: false, value: {}, content: [{ type: "text", text: "edited" }] });
const shell = (extra: Record<string, unknown> = {}): DispatchResult => ({ isError: false, content: [], value: {
  exitCode: 0, signal: null, aborted: false, timedOut: false,
  sandbox: { mode: "workspace-write", denied: false },
  stdout: { text: "bounded", truncated: true, spillPath: "private-output-ref" },
  stderr: { text: "", truncated: false }, ...extra,
} as DispatchResult["value"] & {} });
const denied = (): DispatchResult => ({ isError: true, error: { code: "POLICY_DENIED" }, content: [] });
function fixture() {
  const abort = new AbortController();
  const events: Evidence[] = [];
  const calls: ChildCall[] = [];
  const order: string[] = [];
  const context: Context = { callId: "parent", rootCallId: "root", token: Symbol("parent"), agent: {},
    signal: abort.signal, deferContext: vi.fn(), concludeTurn: vi.fn() };
  const ports: Ports = {
    assertReady: vi.fn(async () => { order.push("ready"); }),
    dispatch: vi.fn(async call => { calls.push(call); order.push(`dispatch:${call.name}`); return call.name === "bash" ? shell() : ok(); }),
    record: vi.fn(async event => { events.push(event); order.push(`${event.operation}:${event.phase}`); return `private:${events.length}`; }),
  };
  return { abort, events, calls, order, context, ports,
    run: (input: unknown = edit()) => createFusionPrototype(ports, { enabled: true }).run(input, context) };
}

describe("inactive Action Fusion orchestration (synthetic ports, not native proof)", () => {
  it("is disabled with zero port effects by default", async () => {
    const f = fixture();
    expect((await createFusionPrototype(f.ports).run(edit(), f.context)).status).toBe("disabled");
    expect(f.order).toEqual([]);
  });
  it("sequences both dispatches through separately awaited evidence with fixed identity", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe("succeeded");
    expect(f.order).toEqual(["ready", "edit:start", "dispatch:edit", "edit:settle", "bash:start", "dispatch:bash", "bash:settle"]);
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call.agent).toBe(f.context.agent);
      expect(call.parent).toBe(f.context.token);
      expect(call.rootCallId).toBe("root");
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(Object.isFrozen(call.arguments)).toBe(true);
    }
    expect(f.calls[0]!.callId).not.toBe(f.calls[1]!.callId);
    expect(result.command).toEqual(shell());
    expect(f.events[3]!.result).toEqual(shell());
    expect(Object.isFrozen(f.events[3]!.result)).toBe(true);
    expect(result.evidenceRefs).toHaveLength(4);
  });
  it("supports write, empty content, and preserves path aliases without rewriting them", async () => {
    const f = fixture();
    const input = { ...edit(), mutation: { name: "write", arguments: { file_path: "file:///synthetic/file", content: "" } } };
    expect((await f.run(input)).status).toBe("succeeded");
    expect(f.calls[0]!.arguments).toEqual(input.mutation.arguments);
  });
  it.each([
    { ...edit(), extra: true },
    { ...edit(), mutation: { name: "bash", arguments: {} } },
    { ...edit(), mutation: { name: "edit", arguments: { ...edit().mutation.arguments, sandbox_permissions: "danger-full-access" } } },
    { ...edit(), command: { ...edit().command, env: {} } },
    { ...edit(), command: { ...edit().command, background: true } },
    { ...edit(), command: { ...edit().command, timeoutMs: 60_001 } },
    { ...edit(), command: { ...edit().command, timeoutMs: 0 } },
    { ...edit(), command: { ...edit().command, command: "x".repeat(4097) } },
    { ...edit(), command: { ...edit().command, workdir: "bad\0path" } },
    { ...edit(), mutation: { name: "edit", arguments: { ...edit().mutation.arguments, new_string: "old" } } },
    { ...edit(), mutation: { name: "write", arguments: { file_path: ".", content: "x".repeat(32_769) } } },
  ])("rejects malformed or privilege-expanding input before any port call", async input => {
    const f = fixture();
    expect((await f.run(input)).code).toBe("INVALID_INPUT");
    expect(f.order).toEqual([]);
  });
  it("rejects accessors without invoking them", async () => {
    const f = fixture();
    const getter = vi.fn();
    const input = Object.defineProperty({}, "mutation", { get: getter });
    expect((await f.run(input)).status).toBe("blocked");
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects non-enumerable arguments instead of losing fields during snapshot", async () => {
    const f = fixture();
    const input = edit();
    Object.defineProperty(input.mutation.arguments, "file_path", { value: "file.py", enumerable: false });
    expect((await f.run(input)).code).toBe("INVALID_INPUT");
    expect(f.order).toEqual([]);
  });
  it("preserves literal whitespace edit semantics", async () => {
    const f = fixture();
    const input = edit();
    input.mutation.arguments.old_string = "  ";
    expect((await f.run(input)).status).toBe("succeeded");
  });
  it("freezes the follow-up before readiness and mutation can change caller input", async () => {
    const f = fixture();
    const input = edit();
    f.ports.assertReady = async () => { input.command.command = "changed"; f.context.rootCallId = "changed"; };
    await f.run(input);
    expect(f.calls[1]!.arguments.command).toBe("check-candidate");
    expect(f.calls[1]!.rootCallId).toBe("root");
  });
  it("blocks unavailable policy/evidence qualification without dispatch", async () => {
    const f = fixture();
    f.ports.assertReady = async () => { throw new Error("private runtime detail"); };
    expect((await f.run()).code).toBe("NOT_READY");
    expect(f.calls).toEqual([]);
  });
  it("classifies readiness cancellation instead of misreporting a readiness failure", async () => {
    const f = fixture();
    f.ports.assertReady = async () => { f.abort.abort(); throw new Error("aborted"); };
    expect((await f.run()).status).toBe("cancelled");
    expect(f.calls).toEqual([]);
  });
  it("classifies readiness deadline cancellation", async () => {
    const f = fixture();
    f.ports.assertReady = signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
    });
    expect((await createFusionPrototype(f.ports, { enabled: true, timeoutMs: 10 }).run(edit(), f.context)).status).toBe("timed_out");
  });
  it.each(["POLICY_DENIED", "CAS_DRIFT", "READ_REQUIRED", "SANDBOX_UNAVAILABLE"])("skips command on delegated mutation error %s without claiming rollback", async code => {
    const f = fixture();
    f.ports.dispatch = vi.fn(async () => ({ isError: true, error: { code }, content: [] }));
    const result = await f.run();
    expect(result.status).toBe("failed");
    expect(result.effects).toBe("possible");
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({ operation: "bash", phase: "skipped" });
  });
  it.each([
    [{ exitCode: 1 }, "failed"], [{ timedOut: true }, "timed_out"], [{ aborted: true }, "cancelled"],
    [{ sandbox: { mode: "workspace-write", denied: true } }, "failed"],
    [{ sandbox: { mode: "workspace-write", denied: false, runnerFailed: true } }, "failed"],
    [{ sandbox: { mode: "danger-full-access", denied: false } }, "failed"],
    [{ signal: "SIGTERM" }, "failed"], [{ exitCode: null }, "failed"],
  ] as const)("does not mistake ordinary shell return for success: %j", async (extra, expected) => {
    const f = fixture();
    f.ports.dispatch = async call => call.name === "bash" ? shell(extra) : ok();
    const result = await f.run();
    expect(result.status).toBe(expected);
    expect(result.mutation).toEqual(ok());
    expect(f.events.at(-1)!.phase).toBe("settle");
  });
  it("independently honors command policy rejection", async () => {
    const f = fixture();
    f.ports.dispatch = async call => call.name === "bash" ? denied() : ok();
    expect((await f.run()).code).toBe("COMMAND_NOT_SUCCESSFUL");
  });
  it("fails closed on a background or malformed command result", async () => {
    const f = fixture();
    f.ports.dispatch = async call => call.name === "bash" ? { isError: false, content: [], value: { jobId: "synthetic" } } : ok();
    expect((await f.run()).status).toBe("failed");
  });
  it.each([1, 2, 3, 4])("stops advancement on evidence failure at append %i", async n => {
    const f = fixture();
    let appended = 0;
    f.ports.record = async () => { if (++appended === n) throw new Error("private sink detail"); return "ref"; };
    const result = await f.run();
    expect(result.status).toBe("incomplete");
    expect(f.calls).toHaveLength(n === 1 ? 0 : n === 4 ? 2 : 1);
    expect(JSON.stringify(result)).not.toContain("private sink detail");
  });
  it("requires a nonempty evidence acknowledgement", async () => {
    const f = fixture();
    f.ports.record = async () => "";
    expect((await f.run()).status).toBe("incomplete");
    expect(f.calls).toEqual([]);
  });
  it("records uncertain dispatch exceptions and never retries", async () => {
    const f = fixture();
    f.ports.dispatch = vi.fn(async () => { throw new Error("private exception"); });
    const result = await f.run();
    expect(result.code).toBe("DISPATCH_OR_RESULT_UNCERTAIN");
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(result.effects).toBe("possible");
    expect(JSON.stringify(result)).not.toContain("private exception");
  });
  it("stops before dispatch on cancellation", async () => {
    const f = fixture();
    f.abort.abort();
    expect((await f.run()).status).toBe("cancelled");
    expect(f.order).toEqual([]);
  });
  it.each(["start", "settle"])("checks cancellation after mutation evidence %s", async phase => {
    const f = fixture();
    const original = f.ports.record;
    f.ports.record = async event => { const ref = await original(event); if (event.operation === "edit" && event.phase === phase) f.abort.abort(); return ref; };
    expect((await f.run()).status).toBe("cancelled");
    expect(f.calls).toHaveLength(phase === "start" ? 0 : 1);
    expect(f.events.at(-1)).toMatchObject({ operation: "bash", phase: "skipped" });
  });
  it("waits for a started child to quiesce; rejects concurrent calls rather than queueing", async () => {
    const f = fixture();
    let release!: (result: DispatchResult) => void;
    f.ports.dispatch = vi.fn(() => new Promise<DispatchResult>(resolve => { release = resolve; }));
    const core = createFusionPrototype(f.ports, { enabled: true });
    let done = false;
    const pending = core.run(edit(), f.context).then(result => { done = true; return result; });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.abort.abort();
    expect((await core.run(edit(), f.context)).status).toBe("busy");
    await Promise.resolve();
    expect(done).toBe(false);
    release(ok());
    expect((await pending).status).toBe("cancelled");
    expect(f.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it("forwards cooperative deadline to a started command and awaits it", async () => {
    const f = fixture();
    f.ports.dispatch = async call => call.name !== "bash" ? ok() : new Promise(resolve => {
      call.signal.addEventListener("abort", () => resolve(shell({ aborted: true })), { once: true });
    });
    const core = createFusionPrototype(f.ports, { enabled: true, timeoutMs: 20 });
    expect((await core.run(edit(), f.context)).status).toBe("timed_out");
  });
  it("forwards native contexts in order and stops if mutation concludes the turn", async () => {
    const f = fixture();
    f.ports.dispatch = async () => ({ ...ok(), additionalContexts: [{ text: "context" }], concludesTurn: true });
    expect((await f.run()).code).toBe("MUTATION_CONCLUDED_TURN");
    expect(f.context.deferContext).toHaveBeenCalledWith({ text: "context" });
    expect(f.context.concludeTurn).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)!.phase).toBe("skipped");
  });
  it("records the skipped command if context forwarding fails after mutation", async () => {
    const f = fixture();
    f.ports.dispatch = async () => ({ ...ok(), additionalContexts: ["synthetic"] });
    f.context.deferContext = () => { throw new Error("context failed"); };
    expect((await f.run()).code).toBe("CONTEXT_FORWARDING_FAILED");
    expect(f.events.at(-1)).toMatchObject({ operation: "bash", phase: "skipped" });
  });
  it.each([NaN, undefined, () => "no", new Date()])("rejects non-JSON results without silently rewriting them", async value => {
    const f = fixture();
    f.ports.dispatch = async () => ({ ...ok(), meta: value } as DispatchResult);
    expect((await f.run()).status).toBe("incomplete");
  });
  it("rejects cyclic results within a bounded depth", async () => {
    const f = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    f.ports.dispatch = async () => ({ ...ok(), value: cyclic } as DispatchResult);
    expect((await f.run()).status).toBe("incomplete");
  });
  it.each(["getter", "extra", "symbol", "sparse"])("rejects non-JSON array %s without invoking getters", async kind => {
    const f = fixture();
    const content: unknown[] = ["plain"];
    const getter = vi.fn(() => "unexpected");
    if (kind === "getter") Object.defineProperty(content, "0", { get: getter });
    if (kind === "extra") Object.defineProperty(content, "extra", { value: "lost" });
    if (kind === "symbol") Object.defineProperty(content, Symbol("extra"), { value: "lost" });
    if (kind === "sparse") { delete content[0]; Object.defineProperty(content, "extra", { value: "lost" }); }
    f.ports.dispatch = async () => ({ ...ok(), content } as DispatchResult);
    expect((await f.run()).status).toBe("incomplete");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["true", false, 1])("rejects malformed turn-conclusion marker %j", async concludesTurn => {
    const f = fixture();
    f.ports.dispatch = async () => ({ ...ok(), concludesTurn } as DispatchResult);
    expect((await f.run()).status).toBe("incomplete");
    expect(f.context.concludeTurn).not.toHaveBeenCalled();
  });
  it("preserves class-method context receivers", async () => {
    const f = fixture();
    class Parent implements Context {
      callId = "parent"; rootCallId = "root"; token = Symbol(); agent = {}; signal = f.abort.signal;
      forwarded: unknown[] = []; ended = false;
      deferContext(value: unknown) { this.forwarded.push(value); }
      concludeTurn() { this.ended = true; }
    }
    const parent = new Parent();
    f.ports.dispatch = async () => ({ ...ok(), additionalContexts: ["context"], concludesTurn: true });
    expect((await createFusionPrototype(f.ports, { enabled: true }).run(edit(), parent)).code).toBe("MUTATION_CONCLUDED_TURN");
    expect(parent.forwarded).toEqual(["context"]);
    expect(parent.ended).toBe(true);
  });
  it("rejects oversized output without running follow-up or inventing successful evidence", async () => {
    const f = fixture();
    f.ports.dispatch = async () => ({ ...ok(), value: "x".repeat(1_048_577) });
    expect((await f.run()).status).toBe("incomplete");
    expect(f.events.at(-1)!.phase).toBe("skipped");
  });
});
