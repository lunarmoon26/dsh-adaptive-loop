/** Default-disabled native dispatch and exact live-writer checkpoint binding. */
import { randomUUID } from "node:crypto";
import type { ToolRuntime, ToolRunContext, ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { createFusionPrototype, type ChildCall, type Context, type DispatchResult, type Outcome } from "./core.js";

/** Compile-time target only, not an attestation of a running DSH composition. */
export const NATIVE_ADAPTER_TARGET = "@deepseek-ai/dsh-tools@0.1.1-rc.2";

export const NATIVE_ADAPTER_BLOCKERS = Object.freeze([
  "DEPLOYED_RUNTIME_COMPOSITION_UNQUALIFIED",
] as const);

/**
 * Translate the generic core's calls to the actual pinned native dispatcher.
 * This low-level seam does not establish readiness or register a model-facing tool.
 * Its service is supplied by the native composition, not dispatch callbacks.
 */
export function bindNativeDispatch(tools: ToolRuntime, parent: ToolRunContext) {
  if (!parent.agent) throw new Error("NATIVE_AGENT_REQUIRED");
  const agent = parent.agent;
  const token = parent.token;
  const rootCallId = parent.rootCallId;
  const signal = parent.signal;
  const deferContext = parent.deferContext.bind(parent);
  const concludeTurn = parent.concludeTurn.bind(parent);
  const context: Context = Object.freeze({
    callId: parent.callId, rootCallId, token, agent, signal,
    // Native accepted contexts pass through the core's lossless JSON snapshot.
    // The native UserMessage type has no generic JSON index signature.
    deferContext: (value: Parameters<Context["deferContext"]>[0]) =>
      deferContext(value as unknown as Parameters<ToolRunContext["deferContext"]>[0]),
    concludeTurn,
  });
  return Object.freeze({
    context,
    async dispatch(call: ChildCall): Promise<DispatchResult> {
      if (call.agent !== agent || call.parent !== token || call.rootCallId !== rootCallId) {
        throw new Error("NATIVE_PARENT_MISMATCH");
      }
      if (!["edit", "write", "bash"].includes(call.name)) throw new Error("NATIVE_LEAF_REJECTED");
      const suffix = call.name === "bash" ? "command" : "mutation";
      if (!new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:${suffix}$`).test(call.callId)) {
        throw new Error("NATIVE_CHILD_ID_INVALID");
      }
      const childSignal = AbortSignal.any([signal, call.signal]);
      if (childSignal.aborted) throw new Error("NATIVE_CANCELLED_BEFORE_DISPATCH");
      const input: ToolExecutionInput = {
        // Only a validated core-generated UUID is branded here. Native parent IDs
        // and tokens above retain their original types and identities.
        callId: call.callId as ToolExecutionInput["callId"],
        rootCallId, parent: token, agent, signal: childSignal,
        name: call.name, arguments: call.arguments,
      };
      const result = await tools.execute(input);
      // The native pipeline returns lossless JSON; the core enforces bounds and
      // makes an immutable snapshot. Do not drop error.info, spill metadata or contexts.
      return result as unknown as DispatchResult;
    },
  });
}

/** Structural extension for patched source; installed 0.1.1 types lack these APIs.
 * `never` parameters bridge native branded IDs and merge-extensible event keys,
 * not caller-controlled readiness. Supply concrete native objects only.
 */
export interface NativeEnvelope { type: string; seq: number; data: unknown; ignorable?: true }
export interface NativeSession {
  readonly id: string;
  readonly seq: number;
  append(type: never, data: never, options: { ignorable: true }): NativeEnvelope;
}
export interface NativeSessionClass {
  readonly prototype: NativeSession;
  create(id: never): NativeSession;
}
export interface NativePersistence {
  bindLiveWriter(session: never, handle: never): () => void;
  checkpoint(session: never, throughSeq: never, options?: { signal?: AbortSignal }):
    Promise<{ sessionId: string; writerId: string; throughSeq: number }>;
}
export interface NativeEvidenceServices {
  Session: NativeSessionClass;
  persistence: NativePersistence;
}
export const NATIVE_CHILD_EVENT = "dal/action-fusion/child";

/** Unregistered adapter. Services come from the native composition, never sinks or readiness callbacks. */
export function createNativeFusionAdapter(tools: ToolRuntime, options: {
  enabled?: boolean; timeoutMs?: number; native?: NativeEvidenceServices;
} = {}) {
  const enabled = options.enabled === true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Validate options now through the core without registering or constructing services.
  const unavailable = async (): Promise<never> => { throw new Error("NATIVE_EVIDENCE_UNAVAILABLE"); };
  createFusionPrototype({ assertReady: unavailable, dispatch: unavailable, record: unavailable }, { timeoutMs });
  let busy = false;
  return Object.freeze({
    target: NATIVE_ADAPTER_TARGET,
    blockers: NATIVE_ADAPTER_BLOCKERS,
    async run(input: unknown, parent: ToolRunContext): Promise<Outcome> {
      if (!enabled) return { status: "disabled", code: "DISABLED", effects: "none_dispatched", evidenceRefs: [] };
      if (busy) return { status: "busy", code: "BUSY", effects: "none_dispatched", evidenceRefs: [] };
      const binding = bindNativeDispatch(tools, parent);
      const session = parent.agent!.session as unknown as NativeSession;
      const sessionId = session.id;
      const native = options.native;
      let writerId: string | undefined;
      let checkpointSignal: AbortSignal;
      const identity = () => {
        if (parent.agent !== binding.context.agent || parent.agent!.session !== session as unknown || session.id !== sessionId
            || !native || Object.getPrototypeOf(session) !== native.Session.prototype
            || session.append !== native.Session.prototype.append) throw new Error("NATIVE_SESSION_MISMATCH");
      };
      const checkpoint = async (seq: number) => {
        identity();
        const ack = await native!.persistence.checkpoint(session as never, seq as never, { signal: checkpointSignal });
        identity();
        if (!ack || ack.sessionId !== session.id || ack.throughSeq !== seq
            || typeof ack.writerId !== "string" || !ack.writerId.trim()
            || (writerId !== undefined && ack.writerId !== writerId)) throw new Error("NATIVE_ACK_MISMATCH");
        writerId = ack.writerId;
      };
      const append = (target: NativeSession, data: unknown) => {
        const seq = target.seq;
        const envelope = target.append(NATIVE_CHILD_EVENT as never, data as never, { ignorable: true });
        if (envelope.ignorable !== true || envelope.type !== NATIVE_CHILD_EVENT || envelope.seq !== seq
            || target.seq !== seq + 1 || !Object.isFrozen(envelope)
            || JSON.stringify(envelope.data) !== JSON.stringify(data)) throw new Error("NATIVE_ENVELOPE_UNSUPPORTED");
        return envelope;
      };
      const core = createFusionPrototype({
        async assertReady(signal) {
          checkpointSignal = signal;
          identity();
          if (typeof native!.persistence.bindLiveWriter !== "function"
              || typeof native!.persistence.checkpoint !== "function") return unavailable();
          // Session.create is detached: no store, notifications, persistence, or model.
          const probe = native!.Session.create(`dal-probe-${randomUUID()}` as never);
          if (probe === session || Object.getPrototypeOf(probe) !== native!.Session.prototype
              || probe.seq !== 0 || probe.append !== session.append) return unavailable();
          append(probe, { probe: true });
          await checkpoint(session.seq - 1);
        },
        dispatch: binding.dispatch,
        async record(event) {
          identity();
          const envelope = append(session, event);
          await checkpoint(envelope.seq);
          return `native-session:${encodeURIComponent(session.id)}:${envelope.seq}:${encodeURIComponent(writerId!)}`;
        },
      }, { enabled: true, timeoutMs });
      busy = true;
      try {
        const result = await core.run(input, binding.context);
        return result.code === "NOT_READY" ? { ...result, code: "NATIVE_EVIDENCE_UNAVAILABLE" } : result;
      } finally { busy = false; }
    },
  });
}
