/** Inactive orchestration prototype. No DSH import, registration, shell or file I/O. */
import { randomUUID } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
export type Leaf = "edit" | "write" | "bash";
export type Status = "succeeded" | "failed" | "cancelled" | "timed_out" | "skipped";

/** A local projection of the inspected dispatcher result, not a native ABI declaration. */
export interface DispatchResult {
  isError: boolean;
  content: Json[];
  value?: Json;
  error?: Json;
  meta?: Json;
  additionalContexts?: Json[];
  concludesTurn?: true;
}
export interface Context {
  callId: string;
  rootCallId: string;
  token: symbol;
  agent: object;
  signal: AbortSignal;
  deferContext(value: Json): void;
  concludeTurn(): void;
}
export interface ChildCall {
  callId: string;
  rootCallId: string;
  parent: symbol;
  agent: object;
  signal: AbortSignal;
  name: Leaf;
  arguments: Readonly<RecordValue>;
}
/** PRIVATE evidence port only: contains native output, never pass directly to DAL feedback. */
export interface Evidence {
  version: 1;
  fusionId: string;
  parentCallId: string;
  rootCallId: string;
  childCallId: string;
  operation: Leaf;
  phase: "start" | "settle" | "skipped";
  status?: Status;
  result?: DispatchResult;
}
export interface Ports {
  /** Adapter verifies its evidence capabilities; this port is not runtime attestation. */
  assertReady(signal: AbortSignal): Promise<void>;
  /** Native adapters MUST delegate to ctx.tools.execute, never a handler body. */
  dispatch(call: ChildCall): Promise<DispatchResult>;
  /** Resolves only after durable acceptance. This core does not implement that guarantee. */
  record(event: Readonly<Evidence>): Promise<string>;
}
export interface Outcome {
  status: "disabled" | "busy" | "blocked" | "incomplete" | "succeeded" | "failed" | "cancelled" | "timed_out";
  code: string;
  effects: "none_dispatched" | "possible";
  evidenceRefs: string[];
  mutation?: DispatchResult;
  command?: DispatchResult;
}

const MAX_TEXT = 32_768;
const MAX_RESULT_BYTES = 1_048_576;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("INVALID_INPUT");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) {
    throw new Error("INVALID_INPUT");
  }
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k))
      || Reflect.ownKeys(value).some(k => typeof k !== "string" || ![...required, ...optional].includes(k))) {
    throw new Error("INVALID_INPUT");
  }
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > max
      || (!empty && !value.trim())) throw new Error("INVALID_INPUT");
  return value;
}
function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new Error("INVALID_INPUT");
  }
  return value;
}
function parse(input: unknown) {
  const request = object(input);
  keys(request, ["mutation", "command"]);
  const mutation = object(request.mutation);
  keys(mutation, ["name", "arguments"]);
  const args = object(mutation.arguments);
  if (mutation.name === "edit") {
    keys(args, ["file_path", "old_string", "new_string"], ["replace_all"]);
    text(args.old_string, MAX_TEXT, true);
    text(args.new_string, MAX_TEXT, true);
    if (args.old_string === "" || args.old_string === args.new_string
        || (Object.hasOwn(args, "replace_all") && typeof args.replace_all !== "boolean")) {
      throw new Error("INVALID_INPUT");
    }
  } else if (mutation.name === "write") {
    keys(args, ["file_path", "content"]);
    text(args.content, MAX_TEXT, true);
  } else throw new Error("INVALID_INPUT");
  text(args.file_path, 4096);
  const command = object(request.command);
  keys(command, ["command", "description", "workdir", "timeoutMs"]);
  text(command.command, 4096);
  text(command.description, 1024);
  text(command.workdir, 4096);
  duration(command.timeoutMs);
  // Own immutable copies before the first await; neither caller nor child can change follow-up.
  return { name: mutation.name as "edit" | "write", args: Object.freeze({ ...args }),
    command: Object.freeze({ ...command }) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function snapshot(result: DispatchResult): DispatchResult {
  // Bound allocation while cloning rather than serializing the entire result first.
  let remaining = MAX_RESULT_BYTES;
  const take = (n: number) => { remaining -= n; if (remaining < 0) throw new Error("INVALID_RESULT"); };
  const copyJson = (value: unknown, depth: number): Json => {
    if (depth > 64) throw new Error("INVALID_RESULT");
    if (value === null || typeof value === "boolean") { take(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > remaining) throw new Error("INVALID_RESULT");
      take(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) { take(String(value).length); return value; }
    if (Array.isArray(value)) {
      take(2 + Math.max(0, value.length - 1));
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("INVALID_RESULT");
      const copy: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("INVALID_RESULT");
        copy.push(copyJson(descriptor.value, depth + 1));
      }
      return copy;
    }
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("INVALID_RESULT");
    }
    take(2);
    const copy: { [key: string]: Json } = {};
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) throw new Error("INVALID_RESULT");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error("INVALID_RESULT");
      copyJson(key, depth + 1);
      take(1 + (count++ > 0 ? 1 : 0));
      Object.defineProperty(copy, key, { value: copyJson(descriptor.value, depth + 1), enumerable: true });
    }
    // Native outcomes are lossless JSON: hidden/symbol properties are not silently discarded.
    if (Reflect.ownKeys(value).length !== count) throw new Error("INVALID_RESULT");
    return copy;
  };
  const copy = copyJson(result, 0) as unknown as DispatchResult;
  if (typeof copy.isError !== "boolean" || !Array.isArray(copy.content)
      || (copy.isError ? copy.error === undefined || copy.value !== undefined || copy.concludesTurn !== undefined
        : copy.value === undefined || copy.error !== undefined)
      || (copy.concludesTurn !== undefined && copy.concludesTurn !== true)
      || (copy.additionalContexts !== undefined && !Array.isArray(copy.additionalContexts))) {
    throw new Error("INVALID_RESULT");
  }
  return freeze(copy);
}
function classify(result: DispatchResult, shell: boolean): Exclude<Status, "skipped"> {
  if (result.isError) return "failed";
  if (!shell) return "succeeded";
  const value = object(result.value);
  if (value.aborted === true) return "cancelled";
  if (value.timedOut === true) return "timed_out";
  const sandbox = object(value.sandbox);
  // Fail closed on missing/ambiguous shell facts and background-handle result variants.
  return value.exitCode === 0 && value.signal === null && value.aborted === false
    && value.timedOut === false && ["read-only", "workspace-write"].includes(String(sandbox.mode))
    && sandbox.denied === false
    && (sandbox.runnerFailed === undefined || sandbox.runnerFailed === false)
    ? "succeeded" : "failed";
}

/** Testable core only. Enabling this object does not install or register a tool. */
export function createFusionPrototype(ports: Ports, options: { enabled?: boolean; timeoutMs?: number } = {}) {
  const enabled = options.enabled === true;
  const timeoutMs = duration(options.timeoutMs ?? 60_000);
  let busy = false;
  return {
    async run(input: unknown, parent: Context): Promise<Outcome> {
      const outcome: Outcome = { status: "blocked", code: "INVALID_INPUT", effects: "none_dispatched", evidenceRefs: [] };
      if (!enabled) return { ...outcome, status: "disabled", code: "DISABLED" };
      if (busy) return { ...outcome, status: "busy", code: "BUSY" };
      let request: ReturnType<typeof parse>;
      try { request = parse(input); } catch { return outcome; }
      const context: Context = { callId: parent.callId, rootCallId: parent.rootCallId,
        token: parent.token, agent: parent.agent, signal: parent.signal,
        deferContext: parent.deferContext.bind(parent), concludeTurn: parent.concludeTurn.bind(parent) };
      busy = true;
      const deadline = new AbortController();
      const signal = AbortSignal.any([context.signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      timer.unref();
      const fusionId = randomUUID();
      const cancellation = (): "cancelled" | "timed_out" => context.signal.aborted ? "cancelled" : "timed_out";
      const finish = (status: Outcome["status"], code: string): Outcome => ({ ...outcome, status, code });
      const event = (name: Leaf, phase: Evidence["phase"], status?: Status, result?: DispatchResult): Evidence => ({
        version: 1, fusionId, parentCallId: context.callId, rootCallId: context.rootCallId,
        childCallId: `${fusionId}:${name === "bash" ? "command" : "mutation"}`, operation: name, phase,
        ...(status === undefined ? {} : { status }), ...(result === undefined ? {} : { result }),
      });
      const record = async (entry: Evidence) => {
        const ref = await ports.record(freeze(entry));
        if (typeof ref !== "string" || !ref.trim() || Buffer.byteLength(ref) > 4096) throw new Error("EVIDENCE_FAILED");
        outcome.evidenceRefs.push(ref);
      };
      const skipCommand = () => record(event("bash", "skipped", "skipped"));
      try {
        if (signal.aborted) return finish(cancellation(), "CANCELLED_BEFORE_START");
        try { await ports.assertReady(signal); } catch {
          return signal.aborted ? finish(cancellation(), "CANCELLED_DURING_READINESS") : finish("blocked", "NOT_READY");
        }
        for (const name of [request.name, "bash"] as const) {
          if (signal.aborted) {
            await record(event(name, "skipped", "skipped"));
            if (name !== "bash") await skipCommand();
            return finish(cancellation(), "CANCELLED_BETWEEN_OPERATIONS");
          }
          await record(event(name, "start"));
          if (signal.aborted) {
            await record(event(name, "skipped", "skipped"));
            if (name !== "bash") await skipCommand();
            return finish(cancellation(), "CANCELLED_BEFORE_DISPATCH");
          }
          outcome.effects = "possible";
          let result: DispatchResult;
          try {
            // No Promise.race: started dispatch must settle even when cancellation is requested.
            result = snapshot(await ports.dispatch(Object.freeze({
              callId: event(name, "start").childCallId, rootCallId: context.rootCallId,
              parent: context.token, agent: context.agent, signal, name,
              arguments: name === "bash" ? request.command : request.args,
            })));
          } catch {
            await record(event(name, "settle", "failed"));
            if (name !== "bash") await skipCommand();
            return finish("incomplete", "DISPATCH_OR_RESULT_UNCERTAIN");
          }
          if (name === "bash") outcome.command = result;
          else outcome.mutation = result;
          let status: Exclude<Status, "skipped">;
          try { status = classify(result, name === "bash"); } catch { status = "failed"; }
          if (signal.aborted) status = cancellation();
          await record(event(name, "settle", status, result));
          try {
            for (const extra of result.additionalContexts ?? []) context.deferContext(extra);
            if (!result.isError && result.concludesTurn) context.concludeTurn();
          } catch {
            if (name !== "bash") await skipCommand();
            return finish("incomplete", "CONTEXT_FORWARDING_FAILED");
          }
          if (!result.isError && result.concludesTurn && name !== "bash") {
            await skipCommand();
            return finish("failed", "MUTATION_CONCLUDED_TURN");
          }
          if (status !== "succeeded") {
            if (name !== "bash") await skipCommand();
            return finish(status, name === "bash" ? "COMMAND_NOT_SUCCESSFUL" : "MUTATION_NOT_SUCCESSFUL");
          }
        }
        return signal.aborted ? finish(cancellation(), "CANCELLED_AT_COMPLETION") : finish("succeeded", "COMPLETED");
      } catch {
        // Evidence/context failures never mask side effects as rolled back or permit follow-up.
        return finish("incomplete", "EVIDENCE_OR_CONTEXT_FAILED");
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
  };
}
