import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";

/**
 * DSH Adaptive Loop run-mode recorder.
 *
 * Subscribes to the dsh session firehose (`session/event`, `session/flush`,
 * `session/disposed`) and projects events into privacy-safe `run-record.v1`
 * documents under each session's workspace `.dal/runs` store. The hot path
 * never blocks on I/O and never throws into the dispatch: accumulation is
 * counter-only and every write happens at a durability checkpoint.
 *
 * Stored facts are digests and counts only — prompt text, message content,
 * tool arguments, and tool results never enter a record.
 */

export const name = "dal-run-record";
export const inject: string[] = [];

export interface Config {
  /** Store root relative to each session's cwd; default ".dal/runs". */
  storeRoot?: string;
  /** Cap on recorded tool-error codes per session; default 64. */
  maxErrorFacts?: number;
}

type ResolvedConfig = Required<Config>;

export interface RuntimeGenerationBinding {
  manifest_sha256: string;
  digest_profile: "rfc8785-jcs-sha256-v1";
  evidence_uri: string;
  assurance: "declared" | "observed" | "verified";
  transition_sequence: number;
  harness_sha256: string;
  model_patch_sha256: string | null;
  harness_pins: Array<{ surface: string; uri: string; sha256: string }>;
}

/** Launcher-owned service contract. The transition sequence must only increase. */
export interface RuntimeGenerationSourceLike {
  bindSession(session: RecordedSessionLike): RuntimeGenerationBinding | null;
  transitionSequence(): number;
}

/** Structural mirrors of the dsh session/event contracts; no dsh runtime import. */
export interface RecordedSessionLike {
  id: string;
  header: { createdAt: number; cwd?: string };
}

export interface RecordedEventLike {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}

export interface CandidateGenerationLike {
  candidateId: string | null;
  candidateSha256: string;
  hmrSequence: number;
  admitted: boolean;
  gitTree: string;
  dshVersion: string;
  profile: string;
}

interface ToolErrorFact {
  name: string;
  code: string;
}

interface SessionAccumulator {
  sessionId: string;
  cwd: string;
  createdAt: number;
  maxSeq: number;
  eventCount: number;
  turns: number;
  steps: number;
  toolCalls: Map<string, number>;
  toolErrors: ToolErrorFact[];
  trace: Array<{ seq: number; turn: number; step: number; tool: string; outcome: "ok" | "failed" | "timeout" | "denied" | "unknown"; code: string | null }>;
  currentTurn: number;
  currentStep: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  lastReason: { kind: string } | null;
  provider: string | null;
  model: string | null;
  systemDigest: string | null;
  inference: Array<{ name: string; value: string }>;
  generationBindingAttempted: boolean;
  runtimeGeneration: {
    binding: RuntimeGenerationBinding;
    source: RuntimeGenerationSourceLike;
  } | null;
  freshSession: boolean;
  candidateGeneration: CandidateGenerationLike | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function fileDigestOrNull(filePath: string): Promise<string | null> {
  try {
    return sha256((await readFile(filePath)).toString("utf8"));
  } catch {
    return null;
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Identifier def: ^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$, length 3..128. */
function identifier(value: string, fallback: string): string {
  let sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z]+/, "");
  if (sanitized === "") {
    sanitized = fallback;
  }
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `x-${sanitized}`;
  }
  return sanitized.slice(0, 128);
}

function failureCategory(code: string): string {
  const upper = code.toUpperCase();
  if (upper.includes("TIMEOUT")) return "timeout";
  if (upper.includes("BUDGET") || upper.includes("MAX_TOKENS")) return "budget_exceeded";
  if (upper.includes("POLICY")) return "policy_denied";
  if (upper.includes("PRIVACY") || upper.includes("SECRET") || upper.includes("PII")) return "privacy_rejection";
  if (upper.includes("SCHEMA")) return "schema_invalid";
  if (upper.includes("CAPSULE")) return "capsule_drift";
  if (upper.includes("EVALUATION")) return "evaluation_hard_stop";
  return "runtime_error";
}

export class RunSessionRecorder {
  private readonly sessions = new Map<string, SessionAccumulator>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly runtimeGenerationSource?: RuntimeGenerationSourceLike,
    private readonly readCandidateGeneration: () => CandidateGenerationLike | null = () => null,
  ) {}

  private currentCandidateGeneration(): CandidateGenerationLike | null {
    try {
      const generation = this.readCandidateGeneration();
      if (
        generation === null
        || (generation.candidateId !== null && typeof generation.candidateId !== "string")
        || !/^[0-9a-f]{64}$/.test(generation.candidateSha256)
        || !Number.isSafeInteger(generation.hmrSequence)
        || generation.hmrSequence < 0
        || typeof generation.admitted !== "boolean"
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(generation.gitTree)
        || typeof generation.dshVersion !== "string"
        || generation.dshVersion === ""
        || typeof generation.profile !== "string"
        || generation.profile === ""
      ) {
        return null;
      }
      return { ...generation };
    } catch {
      return null;
    }
  }

  private accumulator(session: RecordedSessionLike): SessionAccumulator | undefined {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined) {
      return existing;
    }
    const cwd = session.header.cwd;
    if (typeof cwd !== "string" || cwd === "") {
      return undefined;
    }
    const created: SessionAccumulator = {
      sessionId: session.id,
      cwd,
      createdAt: session.header.createdAt,
      maxSeq: 0,
      eventCount: 0,
      turns: 0,
      steps: 0,
      toolCalls: new Map(),
      toolErrors: [],
      trace: [],
      currentTurn: 0,
      currentStep: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      lastReason: null,
      provider: null,
      model: null,
      systemDigest: null,
      inference: [],
      generationBindingAttempted: false,
      runtimeGeneration: null,
      freshSession: false,
      candidateGeneration: null,
    };
    this.sessions.set(session.id, created);
    return created;
  }

  /** Bind runtime and candidate identity exactly once at the new-session boundary. */
  create(session: RecordedSessionLike): void {
    try {
      const state = this.accumulator(session);
      if (state === undefined || state.generationBindingAttempted) {
        return;
      }
      state.generationBindingAttempted = true;
      if (state.eventCount > 0) {
        return;
      }
      state.freshSession = true;
      state.candidateGeneration = this.currentCandidateGeneration();
      if (this.runtimeGenerationSource === undefined) {
        return;
      }
      const binding = this.runtimeGenerationSource.bindSession(session);
      if (!isRuntimeGenerationBinding(binding)) {
        return;
      }
      state.runtimeGeneration = {
        binding: {
          manifest_sha256: binding.manifest_sha256,
          digest_profile: binding.digest_profile,
          evidence_uri: binding.evidence_uri,
          assurance: binding.assurance,
          transition_sequence: binding.transition_sequence,
          harness_sha256: binding.harness_sha256,
          model_patch_sha256: binding.model_patch_sha256,
          harness_pins: binding.harness_pins.map((pin) => ({
            surface: pin.surface,
            uri: pin.uri,
            sha256: pin.sha256,
          })).sort((left, right) =>
            compareText(JSON.stringify(left), JSON.stringify(right)),
          ),
        },
        source: this.runtimeGenerationSource,
      };
    } catch {
      // A missing generation is safer than a partially trusted binding.
    }
  }

  /** Backward-compatible name for callers that bind only runtime generation. */
  bindRuntimeGeneration(session: RecordedSessionLike): void {
    this.create(session);
  }

  /** Counter-only projection; never throws and never touches the filesystem. */
  onEvent(session: RecordedSessionLike, event: RecordedEventLike): void {
    try {
      const state = this.accumulator(session);
      if (state === undefined) {
        return;
      }
      state.maxSeq = Math.max(state.maxSeq, event.seq);
      state.eventCount += 1;
      const data = event.data;
      switch (event.type) {
        case "turn/start":
          state.turns += 1;
          if (typeof data.turn === "number") state.currentTurn = data.turn;
          break;
        case "turn/end": {
          const reason = data.reason;
          if (typeof reason === "object" && reason !== null && "kind" in reason) {
            state.lastReason = { kind: String((reason as { kind: unknown }).kind) };
          }
          break;
        }
        case "step/start":
          state.steps += 1;
          if (typeof data.step === "number") state.currentStep = data.step;
          break;
        case "assistant/message": {
          const usage = data.usage as Record<string, unknown> | undefined;
          if (usage !== undefined && typeof usage === "object") {
            state.usage.input += numeric(usage.inputTokens) ?? 0;
            state.usage.output += numeric(usage.outputTokens) ?? 0;
            state.usage.cacheRead += numeric(usage.cacheReadTokens) ?? 0;
            state.usage.cacheWrite += numeric(usage.cacheWriteTokens) ?? 0;
            state.usage.reasoning += numeric(usage.reasoningTokens) ?? 0;
          }
          break;
        }
        case "tool/call": {
          const toolName = typeof data.name === "string" ? data.name : "unknown";
          state.toolCalls.set(toolName, (state.toolCalls.get(toolName) ?? 0) + 1);
          if (state.trace.length < 512) {
            state.trace.push({
              seq: event.seq,
              turn: state.currentTurn,
              step: state.currentStep,
              tool: identifier(toolName, "tool"),
              outcome: "unknown",
              code: null,
            });
          }
          break;
        }
        case "tool/result": {
          const error = data.error as { name?: unknown; code?: unknown } | undefined;
          if (error !== undefined && typeof error === "object") {
            if (state.toolErrors.length < this.config.maxErrorFacts) {
              state.toolErrors.push({
                name: typeof error.name === "string" ? error.name : "unknown",
                code: typeof error.code === "string" ? error.code : "UNKNOWN",
              });
            }
          }
          let pending: (typeof state.trace)[number] | undefined;
          for (let index = state.trace.length - 1; index >= 0; index -= 1) {
            if (state.trace[index]!.outcome === "unknown") {
              pending = state.trace[index];
              break;
            }
          }
          if (pending !== undefined) {
            const code = error !== undefined && typeof error.code === "string" ? error.code.slice(0, 128) : null;
            const upper = (code ?? "").toUpperCase();
            pending.outcome = code === null ? "ok" : upper.includes("TIMEOUT") ? "timeout" : upper.includes("DENIED") ? "denied" : "failed";
            pending.code = code;
          }
          break;
        }
        case "request/context": {
          if (typeof data.provider === "string") state.provider = data.provider;
          if (typeof data.model === "string") state.model = data.model;
          break;
        }
        case "request/header": {
          const header = data.header as Record<string, unknown> | undefined;
          if (header !== undefined && typeof header === "object") {
            const config = header.config as Record<string, unknown> | undefined;
            if (config !== undefined && typeof config === "object") {
              if (typeof config.provider === "string") state.provider = config.provider;
              if (typeof config.model === "string") state.model = config.model;
              const parameters: Array<[string, unknown]> = [
                ["reasoningEffort", config.reasoningEffort],
                ["temperature", config.temperature],
                ["maxTokens", config.maxTokens],
              ];
              state.inference = parameters
                .filter(([, value]) => value !== undefined)
                .map(([parameterName, value]) => ({ name: parameterName, value: String(value) }));
            }
            if (typeof header.system === "string" && header.system !== "") {
              state.systemDigest = sha256(header.system);
            }
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // Observer failures are contained by contract; never throw into dispatch.
    }
  }

  /** Durability checkpoint: write an immutable per-seq record when a turn closed. */
  async flush(session: RecordedSessionLike): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state === undefined || state.turns === 0) {
      return;
    }
    await this.writeRecord(state, false);
  }

  /** Final record at session teardown, then drop the accumulator. */
  async dispose(session: RecordedSessionLike): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state === undefined || state.eventCount === 0) {
      this.sessions.delete(session.id);
      return;
    }
    try {
      await this.writeRecord(state, true);
    } finally {
      this.sessions.delete(session.id);
    }
  }

  private async writeRecord(state: SessionAccumulator, final: boolean): Promise<void> {
    const lastSeq = state.maxSeq;
    const outcome = this.outcomeOf(state);
    const generation = state.runtimeGeneration;
    const stableForSession = final && generation !== null && generationStable(generation);
    const endGeneration = this.currentCandidateGeneration();
    const startGeneration = state.candidateGeneration;
    const evaluationEligible = final
      && state.freshSession
      && startGeneration !== null
      && endGeneration !== null
      && startGeneration.admitted
      && endGeneration.admitted
      && startGeneration.candidateId !== null
      && startGeneration.candidateId === endGeneration.candidateId
      && startGeneration.candidateSha256 === endGeneration.candidateSha256
      && startGeneration.hmrSequence === endGeneration.hmrSequence;
    const record = {
      $schema: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
      schema_version: "1.0.0",
      run_id: `run-${state.sessionId}-s${lastSeq}`,
      task_id: basename(state.cwd),
      change_id: `chg-dsh-session-${state.sessionId}`,
      started_at: new Date(state.createdAt).toISOString(),
      finished_at: new Date().toISOString(),
      outcome: outcome.outcome,
      record_stage: final ? "final" : "checkpoint",
      failure: outcome.failure,
      context: {
        task_set: identifier(basename(state.cwd), "workspace"),
        environment_snapshot: `${process.platform} ${process.arch} node ${process.versions.node}`,
        tool_versions: [...state.toolCalls.keys()].sort().map((toolName) => ({
          name: identifier(toolName, "tool"),
          version: "unpinned",
        })),
        model:
          state.provider === null || state.model === null
            ? null
            : { id: state.model, version: state.provider },
        prompt_sha256: state.systemDigest,
        harness_sha256: generation?.binding.harness_sha256 ?? null,
        model_patch_sha256: generation?.binding.model_patch_sha256 ?? null,
        grader_version: null,
        seeds: [],
        context_policy_sha256: await fileDigestOrNull(join(state.cwd, "config", "policy.v1.json")),
        inference_parameters: state.inference,
        ...(generation === null ? {} : { harness_pins: generation.binding.harness_pins }),
        candidate_generation: {
          candidate_id: startGeneration?.candidateId ?? null,
          candidate_sha256: startGeneration?.candidateSha256 ?? null,
          start_hmr_sequence: startGeneration?.hmrSequence ?? null,
          end_hmr_sequence: endGeneration?.hmrSequence ?? null,
          evaluation_eligible: evaluationEligible,
          git_tree: startGeneration?.gitTree ?? null,
          dsh_version: startGeneration?.dshVersion ?? null,
          profile: startGeneration?.profile ?? null,
        },
      },
      ...(generation === null
        ? {}
        : {
            runtime_generation: {
              session_id_sha256: sha256(state.sessionId),
              manifest_sha256: generation.binding.manifest_sha256,
              digest_profile: generation.binding.digest_profile,
              evidence_uri: generation.binding.evidence_uri,
              assurance: generation.binding.assurance,
              stable_for_session: stableForSession,
            },
          }),
      artifacts: [],
      business_outcome: null,
      ...(state.trace.length > 0 ? { trace: state.trace } : {}),
      metrics: {
        duration_ms: Math.max(0, Date.now() - state.createdAt),
        tool_calls: [...state.toolCalls.values()].reduce((sum, count) => sum + count, 0),
      },
      evidence: [`dsh-session://${state.sessionId}`],
      privacy: {
        classification: "internal",
        contains_personal_data: false,
        redactions: [],
      },
    };
    const destination = join(resolve(state.cwd, this.config.storeRoot), `${record.run_id}${final ? ".final" : ""}.json`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private outcomeOf(state: SessionAccumulator): {
    outcome: "succeeded" | "failed" | "blocked" | "aborted";
    failure: {
      category: string;
      code: string;
      fingerprint_extra: string[];
      summary: string;
      evidence: string[];
    } | null;
  } {
    const kind = state.lastReason?.kind ?? "completed";
    if (kind === "error") {
      const rawCode = state.toolErrors.at(-1)?.code ?? "TURN_ERROR";
      const code = identifier(rawCode, "error");
      return {
        outcome: "failed",
        failure: {
          category: failureCategory(rawCode),
          code,
          fingerprint_extra: state.toolErrors.slice(0, 16).map((fact) => `${identifier(fact.name, "tool")}-${identifier(fact.code, "error")}`),
          summary: `Session turn failed with code ${code}`,
          evidence: [`dsh-session://${state.sessionId}`],
        },
      };
    }
    if (kind === "max-tokens") {
      return {
        outcome: "failed",
        failure: {
          category: "budget_exceeded",
          code: "MAX_TOKENS",
          fingerprint_extra: [],
          summary: "Session turn reached the output-token ceiling",
          evidence: [`dsh-session://${state.sessionId}`],
        },
      };
    }
    if (kind === "blocked") {
      return { outcome: "blocked", failure: null };
    }
    if (kind === "aborted" || kind === "interrupted") {
      return { outcome: "aborted", failure: null };
    }
    return { outcome: "succeeded", failure: null };
  }
}

interface EventWiringContext {
  on(name: string, listener: (...args: unknown[]) => unknown): unknown;
  get(name: string, strict?: boolean): unknown;
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    storeRoot: config.storeRoot ?? ".dal/runs",
    maxErrorFacts: config.maxErrorFacts ?? 64,
  };
  const wiring = ctx as unknown as EventWiringContext;
  const suppliedSource = wiring.get("runtimeGeneration");
  const source = isRuntimeGenerationSource(suppliedSource)
    ? generationSourceBoundToContext(wiring, suppliedSource)
    : undefined;
  // In-process HMR state is diagnostic only and cannot authorize candidate
  // evaluation. A future trusted launcher-owned source needs its own contract.
  const recorder = new RunSessionRecorder(resolved, source);
  wiring.on("session/created", (session) => {
    recorder.create(session as RecordedSessionLike);
  });
  wiring.on("session/event", (session, event) => {
    recorder.onEvent(session as RecordedSessionLike, event as RecordedEventLike);
  });
  wiring.on("session/flush", async (session) => {
    await recorder.flush(session as RecordedSessionLike);
  });
  wiring.on("session/disposed", async (session) => {
    try {
      await recorder.dispose(session as RecordedSessionLike);
    } catch {
      // Persistence observers cannot fail session disposal.
    }
  });
}

function generationStable(generation: SessionAccumulator["runtimeGeneration"]): boolean {
  if (generation === null) return false;
  try {
    return generation.source.transitionSequence() === generation.binding.transition_sequence;
  } catch {
    return false;
  }
}

function generationSourceBoundToContext(
  ctx: EventWiringContext,
  source: RuntimeGenerationSourceLike,
): RuntimeGenerationSourceLike {
  return {
    bindSession: (session) => source.bindSession(session),
    transitionSequence: () => ctx.get("runtimeGeneration") === source
      ? source.transitionSequence()
      : Number.NaN,
  };
}

function isRuntimeGenerationSource(value: unknown): value is RuntimeGenerationSourceLike {
  return typeof value === "object"
    && value !== null
    && typeof (value as RuntimeGenerationSourceLike).bindSession === "function"
    && typeof (value as RuntimeGenerationSourceLike).transitionSequence === "function";
}

function isRuntimeGenerationBinding(value: unknown): value is RuntimeGenerationBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Partial<RuntimeGenerationBinding>;
  if (!isSha256(binding.manifest_sha256)
    || binding.digest_profile !== "rfc8785-jcs-sha256-v1"
    || !isUri(binding.evidence_uri)
    || !isAssurance(binding.assurance)
    || !Number.isSafeInteger(binding.transition_sequence)
    || (binding.transition_sequence ?? -1) < 0
    || !isSha256(binding.harness_sha256)
    || !(binding.model_patch_sha256 === null || isSha256(binding.model_patch_sha256))
    || !Array.isArray(binding.harness_pins)
    || binding.harness_pins.length > 64) {
    return false;
  }
  const identities = new Set<string>();
  for (const pin of binding.harness_pins) {
    if (typeof pin !== "object" || pin === null
      || Object.keys(pin).sort().join("\u0000") !== "sha256\u0000surface\u0000uri"
      || typeof pin.surface !== "string" || pin.surface.length === 0 || pin.surface.length > 64
      || !isUri(pin.uri) || !isSha256(pin.sha256)) {
      return false;
    }
    const identity = `${pin.surface}\u0000${pin.uri}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUri(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 4
    && value.length <= 2048
    && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value);
}

function isAssurance(value: unknown): value is RuntimeGenerationBinding["assurance"] {
  return value === "declared" || value === "observed" || value === "verified";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
