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

export interface ControllerObservationConfig {
  taskSet: string;
  batchId: string;
  toolVersions: Array<{ name: string; version: string }>;
  model: null | { id: string; version: string };
  promptSha256: string | null;
  harnessSha256: string;
  modelPatchSha256: string | null;
  graderVersion: string | null;
  contextPolicySha256: string;
  inferenceParameters: Array<{ name: string; value: string }>;
  harnessPins: Array<{ surface: string; uri: string; sha256: string }>;
}

export interface Config {
  /** Store root relative to each session's cwd; default ".dal/runs". */
  storeRoot?: string;
  /** Cap on recorded tool-error codes per session; default 64. */
  maxErrorFacts?: number;
  /** Explicit batch and pinned context for controller-eligible terminal records. */
  controllerObservation?: ControllerObservationConfig;
}

interface ResolvedConfig {
  storeRoot: string;
  maxErrorFacts: number;
  controllerObservation: ControllerObservationConfig | null;
}

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
  seeds: number[];
  turnOpen: boolean;
  controllerContextMismatch: boolean;
  generationBindingAttempted: boolean;
  runtimeGeneration: {
    binding: RuntimeGenerationBinding;
    source: RuntimeGenerationSourceLike;
  } | null;
  freshSession: boolean;
  candidateGeneration: CandidateGenerationLike | null;
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/;
const TERMINAL_REASON_KINDS = new Set(["completed", "error", "max-tokens", "blocked", "aborted", "interrupted"]);
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s:/]+:[^\s/@]+@/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{12,}/i,
];
const PII_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i,
  /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/,
  /\b(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/,
];

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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Identifier def: ^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$, length 3..128. */
function identifier(value: string, fallback: string): string {
  let sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (sanitized === "") {
    sanitized = fallback;
  }
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `x-${sanitized}`;
  }
  if (sanitized.length < 3) {
    sanitized = `${sanitized}-${fallback}`;
  }
  sanitized = sanitized.slice(0, 128).replace(/[._-]+$/, "");
  return IDENTIFIER_PATTERN.test(sanitized) && sanitized.length >= 3 ? sanitized : fallback;
}

function resolvedConfig(config: Config): ResolvedConfig {
  const storeRoot = config.storeRoot ?? ".dal/runs";
  if (storeRoot.trim() === "") {
    throw new Error("dal-run-record storeRoot must not be empty");
  }
  const maxErrorFacts = config.maxErrorFacts ?? 64;
  if (!Number.isSafeInteger(maxErrorFacts) || maxErrorFacts < 0) {
    throw new Error("dal-run-record maxErrorFacts must be a non-negative integer");
  }
  return {
    storeRoot,
    maxErrorFacts,
    controllerObservation:
      config.controllerObservation === undefined
        ? null
        : normalizeControllerObservation(config.controllerObservation),
  };
}

function normalizeControllerObservation(value: ControllerObservationConfig): ControllerObservationConfig {
  assertIdentifier(value.taskSet, "controllerObservation.taskSet");
  assertShortText(value.batchId, "controllerObservation.batchId", 128);
  if (value.batchId !== value.batchId.trim()) {
    throw new Error("dal-run-record controllerObservation.batchId cannot contain surrounding whitespace");
  }
  assertArrayLimit(value.toolVersions, "controllerObservation.toolVersions");
  assertArrayLimit(value.inferenceParameters, "controllerObservation.inferenceParameters");
  assertArrayLimit(value.harnessPins, "controllerObservation.harnessPins");
  const toolVersions = value.toolVersions.map((tool, index) => {
    assertIdentifier(tool.name, `controllerObservation.toolVersions[${index}].name`);
    assertShortText(tool.version, `controllerObservation.toolVersions[${index}].version`);
    return { name: tool.name, version: tool.version };
  });
  assertUnique(toolVersions.map((tool) => tool.name), "controllerObservation.toolVersions names");
  const model = value.model === null ? null : normalizeModel(value.model);
  assertNullableDigest(value.promptSha256, "controllerObservation.promptSha256");
  assertDigest(value.harnessSha256, "controllerObservation.harnessSha256");
  assertNullableDigest(value.modelPatchSha256, "controllerObservation.modelPatchSha256");
  assertDigest(value.contextPolicySha256, "controllerObservation.contextPolicySha256");
  if (value.graderVersion !== null && !SEMVER_PATTERN.test(value.graderVersion)) {
    throw new Error("dal-run-record controllerObservation.graderVersion must be null or semantic version");
  }
  const inferenceParameters = value.inferenceParameters.map((parameter, index) => {
    assertIdentifier(parameter.name, `controllerObservation.inferenceParameters[${index}].name`);
    assertShortText(parameter.value, `controllerObservation.inferenceParameters[${index}].value`);
    return { name: parameter.name, value: parameter.value };
  });
  assertUnique(
    inferenceParameters.map((parameter) => parameter.name),
    "controllerObservation.inferenceParameters names",
  );
  const harnessPins = value.harnessPins.map((pin, index) => {
    assertShortText(pin.surface, `controllerObservation.harnessPins[${index}].surface`, 64);
    if (!URI_PATTERN.test(pin.uri) || pin.uri.length > 2048) {
      throw new Error(`dal-run-record controllerObservation.harnessPins[${index}].uri must be a URI`);
    }
    assertDigest(pin.sha256, `controllerObservation.harnessPins[${index}].sha256`);
    return { surface: pin.surface, uri: pin.uri, sha256: pin.sha256 };
  });
  assertUnique(
    harnessPins.map((pin) => `${pin.surface}\u0000${pin.uri}`),
    "controllerObservation.harnessPins identities",
  );
  const normalized = {
    taskSet: value.taskSet,
    batchId: value.batchId,
    toolVersions: canonicalSort(toolVersions),
    model,
    promptSha256: value.promptSha256,
    harnessSha256: value.harnessSha256,
    modelPatchSha256: value.modelPatchSha256,
    graderVersion: value.graderVersion,
    contextPolicySha256: value.contextPolicySha256,
    inferenceParameters: canonicalSort(inferenceParameters),
    harnessPins: canonicalSort(harnessPins),
  };
  assertPrivacySafeMetadata(normalized, "controllerObservation");
  return normalized;
}

function normalizeModel(model: { id: string; version: string }): { id: string; version: string } {
  assertShortText(model.id, "controllerObservation.model.id");
  assertShortText(model.version, "controllerObservation.model.version");
  return { id: model.id, version: model.version };
}

function assertArrayLimit(value: readonly unknown[], field: string): void {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`dal-run-record ${field} must be an array with at most 64 entries`);
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 3 || value.length > 128 || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`dal-run-record ${field} must be a schema-valid identifier`);
  }
}

function assertShortText(value: string, field: string, maximum = 512): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !/\S/.test(value)) {
    throw new Error(`dal-run-record ${field} must be non-empty text of at most ${maximum} characters`);
  }
}

function assertDigest(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`dal-run-record ${field} must be a lowercase sha256 digest`);
  }
}

function assertNullableDigest(value: string | null, field: string): void {
  if (value !== null) assertDigest(value, field);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`dal-run-record ${field} must be unique`);
  }
}

function canonicalSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  });
}

function assertPrivacySafeMetadata(value: unknown, label: string): void {
  let unsafe = false;
  const visit = (current: unknown, fieldName?: string): void => {
    if (typeof current === "string") {
      if (SECRET_PATTERNS.some((pattern) => pattern.test(current)) || PII_PATTERNS.some((pattern) => pattern.test(current))) {
        unsafe = true;
      } else if (!(fieldName?.toLowerCase().endsWith("sha256") ?? false) && containsPaymentCard(current)) {
        unsafe = true;
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item));
      return;
    }
    if (current !== null && typeof current === "object") {
      Object.entries(current as Record<string, unknown>).forEach(([name, child]) => visit(child, name));
    }
  };
  visit(value);
  if (unsafe) {
    throw new Error(`dal-run-record ${label} contains likely secret or personal data; nothing was persisted`);
  }
}

function containsPaymentCard(text: string): boolean {
  for (const match of text.matchAll(/(?<![A-Za-z0-9])(?:\d[ -]?){13,19}(?![A-Za-z0-9])/g)) {
    const digits = match[0].replaceAll(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
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
  private readonly config: ResolvedConfig;

  constructor(
    config: Config = {},
    private readonly runtimeGenerationSource?: RuntimeGenerationSourceLike,
    private readonly readCandidateGeneration: () => CandidateGenerationLike | null = () => null,
  ) {
    this.config = resolvedConfig(config);
  }

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
      seeds: [],
      turnOpen: false,
      controllerContextMismatch: false,
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
          state.turnOpen = true;
          state.lastReason = null;
          if (typeof data.turn === "number") state.currentTurn = data.turn;
          break;
        case "turn/end": {
          state.turnOpen = false;
          const reason = data.reason;
          if (typeof reason === "object" && reason !== null && "kind" in reason) {
            const kind = (reason as { kind: unknown }).kind;
            state.lastReason = typeof kind === "string" && kind !== "" ? { kind } : null;
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
          const normalizedToolName = identifier(toolName, "tool");
          const observation = this.config.controllerObservation;
          if (
            observation !== null &&
            (toolName !== normalizedToolName || !observation.toolVersions.some((tool) => tool.name === normalizedToolName))
          ) {
            state.controllerContextMismatch = true;
          }
          state.toolCalls.set(toolName, (state.toolCalls.get(toolName) ?? 0) + 1);
          if (state.trace.length < 512) {
            state.trace.push({
              seq: event.seq,
              turn: state.currentTurn,
              step: state.currentStep,
              tool: normalizedToolName,
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
          if (observedModelContradicts(this.config.controllerObservation, data.provider, data.model)) {
            state.controllerContextMismatch = true;
          }
          if (typeof data.provider === "string") state.provider = data.provider;
          if (typeof data.model === "string") state.model = data.model;
          break;
        }
        case "request/header": {
          const header = data.header as Record<string, unknown> | undefined;
          if (header !== undefined && typeof header === "object") {
            const config = header.config as Record<string, unknown> | undefined;
            if (config !== undefined && typeof config === "object") {
              if (observedModelContradicts(this.config.controllerObservation, config.provider, config.model)) {
                state.controllerContextMismatch = true;
              }
              if (typeof config.provider === "string") state.provider = config.provider;
              if (typeof config.model === "string") state.model = config.model;
              const parameters: Array<[string, unknown]> = [
                ["reasoning_effort", config.reasoningEffort],
                ["temperature", config.temperature],
                ["max_tokens", config.maxTokens],
              ];
              state.inference = parameters
                .filter(([, value]) => value !== undefined)
                .map(([parameterName, value]) => ({ name: parameterName, value: String(value) }));
              const observation = this.config.controllerObservation;
              if (
                observation !== null &&
                JSON.stringify(canonicalSort(state.inference)) !== JSON.stringify(observation.inferenceParameters)
              ) {
                state.controllerContextMismatch = true;
              }
              const seed = numeric(config.seed);
              if (seed !== undefined && !state.seeds.includes(seed)) {
                state.seeds.push(seed);
                state.seeds.sort((left, right) => left - right);
              }
            }
            if (typeof header.system === "string") {
              state.systemDigest = sha256(header.system);
              const observation = this.config.controllerObservation;
              if (observation !== null && state.systemDigest !== observation.promptSha256) {
                state.controllerContextMismatch = true;
              }
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
    if (state === undefined || state.turns === 0 || state.turnOpen || state.lastReason === null) {
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
    const observation = this.controllerObservationFor(state, final);
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
        ...(observation === null
          ? {
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
              seeds: state.seeds,
              context_policy_sha256: await fileDigestOrNull(join(state.cwd, "config", "policy.v1.json")),
              inference_parameters: canonicalSort(state.inference),
              ...(generation === null ? {} : { harness_pins: generation.binding.harness_pins }),
            }
          : {
              task_set: observation.taskSet,
              environment_snapshot: `${process.platform} ${process.arch} node ${process.versions.node}`,
              tool_versions: observation.toolVersions,
              model: observation.model,
              prompt_sha256: observation.promptSha256,
              harness_sha256: generation?.binding.harness_sha256 ?? observation.harnessSha256,
              model_patch_sha256: generation === null ? observation.modelPatchSha256 : generation.binding.model_patch_sha256,
              grader_version: observation.graderVersion,
              seeds: state.seeds,
              context_policy_sha256: observation.contextPolicySha256,
              inference_parameters: observation.inferenceParameters,
              harness_pins: generation?.binding.harness_pins ?? observation.harnessPins,
            }),
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
      batch_id: observation?.batchId ?? null,
      ...(state.trace.length > 0 ? { trace: state.trace } : {}),
      metrics: {
        duration_ms: Math.max(0, Date.now() - state.createdAt),
        tool_calls: [...state.toolCalls.values()].reduce((sum, count) => sum + count, 0),
        input_tokens: state.usage.input,
        output_tokens: state.usage.output,
        cache_read_tokens: state.usage.cacheRead,
        cache_write_tokens: state.usage.cacheWrite,
        reasoning_tokens: state.usage.reasoning,
      },
      evidence: [`dsh-session://${state.sessionId}`],
      privacy: {
        classification: "internal",
        contains_personal_data: false,
        redactions: [],
      },
    };
    assertPrivacySafeMetadata(record, "record");
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

  private controllerObservationFor(
    state: SessionAccumulator,
    final: boolean,
  ): ControllerObservationConfig | null {
    const observation = this.config.controllerObservation;
    if (
      !final ||
      observation === null ||
      state.turns === 0 ||
      state.turnOpen ||
      state.lastReason === null ||
      !TERMINAL_REASON_KINDS.has(state.lastReason.kind) ||
      state.controllerContextMismatch ||
      !sameModel(state, observation.model) ||
      state.systemDigest !== observation.promptSha256 ||
      JSON.stringify(canonicalSort(state.inference)) !== JSON.stringify(observation.inferenceParameters)
    ) {
      return null;
    }
    const configuredTools = new Set(observation.toolVersions.map((tool) => tool.name));
    const generation = state.runtimeGeneration;
    if (generation !== null && (
      !generationStable(generation) ||
      generation.binding.harness_sha256 !== observation.harnessSha256 ||
      generation.binding.model_patch_sha256 !== observation.modelPatchSha256 ||
      JSON.stringify(canonicalSort(generation.binding.harness_pins)) !== JSON.stringify(observation.harnessPins)
    )) {
      return null;
    }
    const usedTools = [...state.toolCalls.keys()].map((tool) => identifier(tool, "tool"));
    return usedTools.every((tool) => configuredTools.has(tool)) ? observation : null;
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
    const kind = state.lastReason?.kind;
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
    if (kind === "completed") {
      return { outcome: "succeeded", failure: null };
    }
    return { outcome: "aborted", failure: null };
  }
}

interface EventWiringContext {
  on(name: string, listener: (...args: unknown[]) => unknown): unknown;
  get(name: string, strict?: boolean): unknown;
}

export function apply(ctx: Context, config: Config): void {
  const wiring = ctx as unknown as EventWiringContext;
  const suppliedSource = wiring.get("runtimeGeneration");
  const source = isRuntimeGenerationSource(suppliedSource)
    ? generationSourceBoundToContext(wiring, suppliedSource)
    : undefined;
  // In-process HMR state is diagnostic only and cannot authorize candidate
  // evaluation. A future trusted launcher-owned source needs its own contract.
  const recorder = new RunSessionRecorder(config, source);
  wiring.on("session/created", (session) => {
    recorder.create(session as RecordedSessionLike);
  });
  wiring.on("session/event", (session, event) => {
    recorder.onEvent(session as RecordedSessionLike, event as RecordedEventLike);
  });
  wiring.on("session/flush", async (session) => {
    await recorder.flush(session as RecordedSessionLike).catch(() => undefined);
  });
  wiring.on("session/disposed", async (session) => {
    await recorder.dispose(session as RecordedSessionLike).catch(() => undefined);
  });
}

function sameModel(state: SessionAccumulator, model: ControllerObservationConfig["model"]): boolean {
  if (model === null) return state.provider === null && state.model === null;
  return state.model === model.id && state.provider === model.version;
}

function observedModelContradicts(
  observation: ControllerObservationConfig | null,
  provider: unknown,
  model: unknown,
): boolean {
  if (observation === null || (typeof provider !== "string" && typeof model !== "string")) return false;
  if (observation.model === null) return true;
  return (
    (typeof provider === "string" && provider !== observation.model.version) ||
    (typeof model === "string" && model !== observation.model.id)
  );
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
