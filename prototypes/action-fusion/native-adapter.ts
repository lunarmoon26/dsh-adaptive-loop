/** Inactive native dispatch binding; durable native evidence is not yet available. */
import type { ToolRuntime, ToolRunContext, ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { createFusionPrototype, type ChildCall, type Context, type DispatchResult, type Outcome } from "./core.js";

/** Compile-time target only, not an attestation of a running DSH composition. */
export const NATIVE_ADAPTER_TARGET = "@deepseek-ai/dsh-tools@0.1.1-rc.2";

export const NATIVE_ADAPTER_BLOCKERS = Object.freeze([
  "NATIVE_CHILD_EVENT_ENVELOPE_UNSUPPORTED",
  "EXACT_SESSION_DURABLE_WRITER_UNQUALIFIED",
  "DEPLOYED_RUNTIME_COMPOSITION_UNQUALIFIED",
] as const);

/**
 * Translate the generic core's calls to the actual pinned native dispatcher.
 * This low-level seam does not establish readiness or register a model-facing tool.
 * Its service is supplied by a future approved native composition, not callbacks.
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

/**
 * Inactive adapter entrypoint. No flag or injected sink can bypass the known
 * native evidence blockers. Installing/mounting and integration are separate work.
 */
export function createNativeFusionAdapter(tools: ToolRuntime, options: { enabled?: boolean; timeoutMs?: number } = {}) {
  const enabled = options.enabled === true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Validate options now through the core without registering or constructing services.
  const unavailable = async (): Promise<never> => { throw new Error("NATIVE_EVIDENCE_UNAVAILABLE"); };
  createFusionPrototype({ assertReady: unavailable, dispatch: unavailable, record: unavailable }, { timeoutMs });
  return Object.freeze({
    target: NATIVE_ADAPTER_TARGET,
    blockers: NATIVE_ADAPTER_BLOCKERS,
    async run(input: unknown, parent: ToolRunContext): Promise<Outcome> {
      if (!enabled) return { status: "disabled", code: "DISABLED", effects: "none_dispatched", evidenceRefs: [] };
      const binding = bindNativeDispatch(tools, parent);
      const core = createFusionPrototype({
        assertReady: unavailable,
        dispatch: binding.dispatch,
        record: unavailable,
      }, { enabled: true, timeoutMs });
      const result = await core.run(input, binding.context);
      return result.code === "NOT_READY" ? { ...result, code: "NATIVE_EVIDENCE_UNAVAILABLE" } : result;
    },
  });
}
