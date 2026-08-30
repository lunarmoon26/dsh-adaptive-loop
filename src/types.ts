export const SENSITIVE_ACTIONS = [
  "change_shared_harness_config",
  "install_or_mount_plugin",
  "send_data_externally",
  "apply_optimization_candidate",
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];
export type ActorKind = "human" | "dsh-agent" | "automation" | "import";

export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface Policy {
  $schema: string;
  schema_version: "1.0.0";
  default_store: string;
  max_feedback_bytes: number;
  max_store_records: number;
  secret_ruleset_version: string;
  pii_ruleset_version: string;
  allowed_evidence_schemes: string[];
  sensitive_actions: SensitiveAction[];
  capsule_max_claims: number;
  capsule_max_retrieval_pointers: number;
  default_guardrail_audit_store: string;
  default_evaluation_store: string;
  default_run_store: string;
  default_cluster_store: string;
  allowed_capabilities: GuardrailCapability[];
  denied_capabilities: GuardrailCapability[];
  allowed_tool_operations: string[];
  allowed_write_roots: string[];
  proposal_write_root: "repo://.dal/proposals";
  editable_surfaces: EditableSurface[];
  immutable_anchors: ImmutableAnchor[];
  max_policy_checks_per_window: number;
  policy_window_seconds: number;
  max_action_calls: number;
  max_action_duration_ms: number;
  max_action_bytes_read: number;
  max_action_bytes_written: number;
  max_network_requests: 0;
  max_external_cost_usd: 0;
  max_evaluation_cases: number;
  max_evaluation_duration_ms: number;
  max_evaluation_tool_calls: number;
  docker_image?: string;
  docker_run_flags?: string[];
  docker_env_names?: string[];
}

export const EDITABLE_SURFACES = [
  "prompt",
  "tool_descriptions",
  "skills",
  "memory_policy",
  "routing",
  "stop_retry_logic",
  "harness_code",
] as const;

export const IMMUTABLE_ANCHORS = [
  "evaluator",
  "sealed_holdout",
  "permissions",
  "maximum_budget",
  "promotion_policy",
  "audit_log",
  "rollback_mechanism",
] as const;

export type EditableSurface = (typeof EDITABLE_SURFACES)[number];
export type ImmutableAnchor = (typeof IMMUTABLE_ANCHORS)[number];
export type ProposalSurface = EditableSurface | ImmutableAnchor;

export type CriterionResult = "passed" | "failed" | "not_run" | "not_applicable";
export type FeedbackOutcome = "completed" | "blocked" | "aborted";

export interface EvidenceItem {
  id: string;
  kind: "command" | "test" | "file" | "commit" | "url" | "session_event" | "human_note";
  uri: string;
  summary: string;
  sha256: string | null;
  observed_at: string;
}

export interface FeedbackLog {
  $schema: string;
  schema_version: "1.0.0";
  feedback_id: string;
  change_id: string;
  created_at: string;
  supersedes: string | null;
  producer: {
    actor: Actor;
    harness: null | {
      name: string;
      version: string | null;
      session_id: string | null;
    };
    repository: {
      root: string;
      revision: string | null;
      branch: string | null;
      dirty: boolean;
    };
    task_ref: string | null;
  };
  goal: string;
  acceptance_criteria: Array<{
    id: string;
    statement: string;
    result: CriterionResult;
    evidence: string[];
  }>;
  outcome: {
    status: FeedbackOutcome;
    summary: string;
    exception: null | {
      kind: "blocked" | "aborted";
      reason: string;
      owner: string;
      next_action: string;
    };
  };
  what_worked: string[];
  what_failed: string[];
  calls: Array<{
    sequence: number;
    kind: "tool" | "harness" | "plugin";
    name: string;
    purpose: string;
    outcome: "succeeded" | "failed" | "cancelled" | "denied";
    duration_ms: number | null;
    evidence: string[];
  }>;
  failures_and_inefficiencies: Array<{
    id: string;
    category: string;
    summary: string;
    impact: "low" | "medium" | "high";
    recoverable: boolean;
    suggested_action: string | null;
    evidence: string[];
  }>;
  evidence: EvidenceItem[];
  uncertainty: Array<{
    id: string;
    statement: string;
    level: "low" | "medium" | "high";
    resolution: string;
    evidence: string[];
  }>;
  human_review: {
    status: "not_requested" | "pending" | "approved" | "changes_requested" | "rejected" | "not_required";
    reviewer: string | null;
    reviewed_at: string | null;
    notes: string[];
    approval_refs: string[];
  };
  privacy: {
    classification: "public" | "internal" | "restricted";
    retention: "ephemeral" | "local-only" | "team";
    tags: string[];
    contains_personal_data: boolean;
    redactions: Array<{
      path: string;
      reason: string;
      marker: string;
    }>;
  };
}

export interface StoredFeedbackRecord {
  $schema: string;
  storage_version: "1.0.0";
  record_id: string;
  ingested_at: string;
  source: {
    display_path: string;
    sha256: string;
  };
  feedback_sha256: string;
  privacy_scan: {
    ruleset_version: string;
    pii_ruleset_version: string;
    status: "passed";
    scanned_at: string;
    matched_rules: [];
  };
  feedback: FeedbackLog;
}

export interface ApprovalDecision {
  $schema: string;
  schema_version: "1.0.0";
  decision_id: string;
  request_id: string;
  action: SensitiveAction;
  scope: {
    kind: "artifact" | "configuration" | "data_transfer" | "plugin" | "proposal";
    value: string;
    sha256: string;
  };
  decision: "approved" | "rejected";
  reviewer: {
    kind: "human";
    id: string;
  };
  decided_at: string;
  expires_at: string;
  rationale: string;
  evidence: string[];
  candidate_sha256: string | null;
}

export const PROPOSAL_STAGES = [
  "observed",
  "normalized",
  "human_reviewed",
  "proposed",
  "sandbox_evaluated",
  "awaiting_decision",
  "approved",
  "rejected",
  "applied",
  "measured",
] as const;

export type ProposalStage = (typeof PROPOSAL_STAGES)[number];

export interface ImprovementProposal {
  $schema: string;
  schema_version: "1.0.0";
  proposal_id: string;
  title: string;
  created_at: string;
  source_feedback_ids: string[];
  objective: string;
  target: {
    kind: "prompt" | "skill" | "cordis_plugin" | "harness_rule" | "shared_config";
    uri: string;
    base_sha256: string;
    surface: ProposalSurface;
  };
  stage: ProposalStage;
  prediction: null | {
    statement: string;
    improvements: Array<{
      metric:
        | "task_success_rate"
        | "test_pass_rate"
        | "policy_precision"
        | "policy_recall"
        | "blocked_dangerous_action_rate"
        | "human_override_rate"
        | "post_change_regression_rate";
      expected_delta: number;
    }>;
    regressions: Array<{
      summary: string;
      severity: "low" | "medium" | "high";
    }>;
  };
  candidate: null | {
    format: "complete_text" | "bounded_edits";
    artifact_uri: string;
    sha256: string;
    edit_count: number;
  };
  evaluation: null | {
    environment: "sandbox";
    receipt_uri: string;
    scorecard_uri: string;
    scorecard_sha256: string;
    scorecard_result: "pass" | "hard_stop";
    metric:
      | "task_success_rate"
      | "test_pass_rate"
      | "policy_precision"
      | "policy_recall"
      | "blocked_dangerous_action_rate"
      | "human_override_rate"
      | "post_change_regression_rate";
    baseline_score: number;
    candidate_score: number;
    regression_detected: boolean;
    evidence: string[];
  };
  decision_ref: string | null;
  history: Array<{
    from: ProposalStage | null;
    to: ProposalStage;
    actor: Actor;
    at: string;
    evidence: string[];
    notes: string;
  }>;
  measurements: Array<{
    metric: string;
    before: number;
    after: number;
    measured_at: string;
    evidence: string[];
  }>;
}

export interface KnowledgeCapsule {
  $schema: string;
  schema_version: "1.0.0";
  capsule_id: string;
  capsule_version: string;
  title: string;
  audience: string;
  checked_at: string;
  refresh_after: string;
  sources: Array<{
    id: string;
    kind: "local_file" | "git_file" | "url";
    uri: string;
    revision: string | null;
    sha256: string;
    local_path: string | null;
    required: boolean;
  }>;
  claims: Array<{
    id: string;
    text: string;
    source_ids: string[];
  }>;
  retrieval_pointers: Array<{
    id: string;
    when: string;
    uri: string;
    source_ids: string[];
  }>;
  limits: string[];
}

export interface OptimizerExchange {
  $schema: string;
  schema_version: "1.0.0";
  exchange_id: string;
  mode: "prepare_only";
  provider_hint: "gepa" | "skillopt" | null;
  target: {
    kind: "prompt" | "skill" | "cordis_plugin" | "harness_rule";
    artifact_uri: string;
    base_sha256: string;
    format: "complete_text" | "named_components" | "bounded_edits";
  };
  objective: {
    goal: string;
    metrics: string[];
    higher_is_better: boolean;
  };
  datasets: {
    train: string[];
    validation: string[];
    test: string[];
  };
  budget: {
    max_evaluations: number;
    max_candidates: number;
    max_wall_time_seconds: number;
    max_external_cost_usd: number;
  };
  privacy: {
    classification: "public" | "internal" | "restricted";
    external_transfer_approved: false;
    approval_ref: null;
  };
  result: null;
}

export const GUARDRAIL_CAPABILITIES = [
  "read_local",
  "write_local_evidence",
  "run_local_verifier",
  "network_access",
  "destructive_shell",
  "write_outside_workspace",
  "plugin_management",
  "shared_configuration",
  "candidate_application",
  "privilege_escalation",
] as const;

export type GuardrailCapability = (typeof GUARDRAIL_CAPABILITIES)[number];
export type GuardrailEffect = "allowed" | "denied" | "requires_human_approval";
export type ArtifactKind = "plugin" | "skill" | "knowledge_capsule" | "optimizer_proposal" | "other";

export interface GuardrailAction {
  $schema: string;
  schema_version: "1.0.0";
  action_id: string;
  created_at: string;
  actor: Actor;
  input_trust: "trusted" | "untrusted_repo" | "external";
  capability: GuardrailCapability;
  tool: {
    name: string;
    operation: string;
  };
  target: {
    uri: string;
    artifact_kind: ArtifactKind | null;
    artifact_id: string | null;
    sha256: string | null;
  };
  data: {
    classification: "public" | "internal" | "restricted";
    contains_personal_data: boolean;
    redacted: boolean;
  };
  sandbox: {
    mode: "none" | "read_only" | "isolated_write";
    network: "denied" | "allowlisted" | "unrestricted";
    writable_roots: string[];
  };
  budget: {
    max_calls: number;
    max_duration_ms: number;
    max_bytes_read: number;
    max_bytes_written: number;
    max_network_requests: number;
  };
  approval_ref: string | null;
}

export interface GuardrailDecision {
  $schema: string;
  storage_version: "1.0.0";
  decision_id: string;
  evaluated_at: string;
  effect: GuardrailEffect;
  request_sha256: string;
  policy_sha256: string;
  policy_version: string;
  secret_ruleset_version: string;
  pii_ruleset_version: string;
  evaluator: "rdl-deterministic-policy-v1";
  matched_rules: Array<{
    id: string;
    effect: GuardrailEffect;
    summary: string;
  }>;
  approval_ref: string | null;
  approval_sha256: string | null;
  request: GuardrailAction;
}

export type EvaluationCategory =
  | "offline"
  | "adversarial"
  | "regression"
  | "golden"
  | "policy_violation"
  | "integration_sandbox";

export type EvaluationEffect = "allowed" | "rejected" | "requires_human_approval";
export type EvaluationArtifactKind = Exclude<ArtifactKind, "other"> | "rdl_runtime";

export interface EvaluationArtifact {
  kind: EvaluationArtifactKind;
  id: string;
  uri: string;
  sha256: string;
}

export interface EvaluationSuite {
  $schema: string;
  schema_version: "1.0.0";
  suite_id: string;
  suite_version: string;
  created_at: string;
  target: EvaluationArtifact;
  contamination: {
    status: "reviewed_clean" | "detected" | "unknown";
    reviewer: string | null;
    reviewed_at: string | null;
    notes: string;
  };
  cases: Array<{
    id: string;
    category: EvaluationCategory;
    kind: "guardrail_action" | "feedback";
    fixture: {
      uri: string;
      local_path: string;
      sha256: string;
    };
    expected_effect: EvaluationEffect;
    expected_code: string | null;
    dangerous: boolean;
    human_override: boolean;
  }>;
  thresholds: {
    min_task_success_rate: number;
    min_test_pass_rate: number;
    min_policy_precision: number;
    min_policy_recall: number;
    min_blocked_dangerous_action_rate: number;
    max_human_override_rate: number;
    max_post_change_regression_rate: number;
  };
  budget: {
    max_cases: number;
    max_duration_ms: number;
    max_tool_calls: number;
    max_external_requests: 0;
    max_external_cost_usd: 0;
  };
}

export interface EvaluationScorecard {
  $schema: string;
  storage_version: "1.0.0";
  scorecard_id: string;
  suite_id: string;
  suite_version: string;
  target: EvaluationArtifact;
  started_at: string;
  finished_at: string;
  provenance: {
    suite_uri: string;
    suite_sha256: string;
    suite_snapshot: EvaluationSuite;
    fixture_set_sha256: string;
    policy_sha256: string;
    policy_snapshot: Policy;
  };
  evaluators: Array<{
    kind: "deterministic" | "model_judge" | "human";
    id: string;
    version: string;
    external: boolean;
  }>;
  case_results: Array<{
    case_id: string;
    category: EvaluationCategory;
    expected_effect: EvaluationEffect;
    observed_effect: EvaluationEffect;
    code: string | null;
    dangerous: boolean;
    human_override: boolean;
    passed: boolean;
    duration_ms: number;
  }>;
  metrics: {
    task_success_rate: number;
    test_pass_rate: number;
    policy_precision: number;
    policy_recall: number;
    blocked_dangerous_action_rate: number;
    human_override_rate: number;
    post_change_regression_rate: number;
  };
  threshold_results: Array<{
    metric: keyof EvaluationScorecard["metrics"];
    comparator: "gte" | "lte";
    threshold: number;
    observed: number;
    passed: boolean;
  }>;
  budget: {
    duration_ms: number;
    tool_calls: number;
    external_requests: 0;
    external_cost_usd: 0;
    within_budget: boolean;
  };
  contamination: EvaluationSuite["contamination"];
  model_judge_results: Array<{
    judge_id: string;
    score: number;
    summary: string;
    evidence: string[];
  }>;
  human_review: {
    status: "not_requested" | "pending" | "approved" | "rejected" | "changes_requested";
    reviewer: string | null;
    reviewed_at: string | null;
    notes: string[];
  };
  result: "pass" | "hard_stop";
  hard_stop: {
    triggered: boolean;
    reasons: string[];
    disposition: "continue" | "quarantine" | "rollback";
  };
}

export const RUN_FAILURE_CATEGORIES = [
  "test_failure",
  "build_failure",
  "type_error",
  "policy_denied",
  "privacy_rejection",
  "schema_invalid",
  "capsule_drift",
  "evaluation_hard_stop",
  "runtime_error",
  "timeout",
  "budget_exceeded",
  "other",
] as const;

export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];
export type RunOutcome = "succeeded" | "failed" | "blocked" | "aborted";

export interface RunRecord {
  $schema: string;
  schema_version: "1.0.0";
  run_id: string;
  task_id: string;
  change_id: string;
  started_at: string;
  finished_at: string;
  outcome: RunOutcome;
  failure: null | {
    category: RunFailureCategory;
    code: string;
    fingerprint_extra: string[];
    summary: string;
    evidence: string[];
  };
  context: {
    task_set: string;
    environment_snapshot: string;
    tool_versions: Array<{ name: string; version: string }>;
    model: null | { id: string; version: string };
    prompt_sha256: string | null;
    harness_sha256: string | null;
    grader_version: string | null;
    seeds: number[];
    context_policy_sha256: string | null;
    inference_parameters: Array<{ name: string; value: string }>;
    harness_pins?: Array<{ surface: string; uri: string; sha256: string }>;
    model_patch_sha256?: string | null;
  };
  artifacts: Array<{ uri: string; sha256: string; description: string }>;
  metrics: { duration_ms: number; tool_calls: number };
  evidence: string[];
  trace?: Array<{
    seq: number;
    turn: number;
    step: number;
    tool: string;
    outcome: "ok" | "failed" | "timeout" | "denied" | "unknown";
    code: string | null;
  }>;
  checks?: Array<{ id: string; pass: boolean; detail: string | null; goal_sha256: string; actual_sha256: string }>;
  batch_id?: string | null;
  business_outcome?: {
    status: "passed" | "failed" | "unknown";
    source: string;
    score?: number;
    earned?: number;
    total?: number;
  } | null;
  privacy: {
    classification: "public" | "internal" | "restricted";
    contains_personal_data: boolean;
    redactions: Array<{ path: string; reason: string; marker: string }>;
  };
}

export interface ClusterRecord {
  $schema: string;
  schema_version: "1.0.0";
  cluster_id: string;
  created_at: string;
  evaluator: "rdl-deterministic-clustering-v1";
  tier: "fingerprint";
  fingerprint: {
    category: RunFailureCategory;
    code: string;
    signature: string;
  };
  members: Array<{ run_id: string; record_uri: string; sha256: string }>;
  representative: { run_id: string; record_uri: string; sha256: string };
  member_count: number;
  summary: string;
}


export interface OptimizerTrainingSet {
  $schema: string;
  schema_version: "1.0.0";
  training_set_id: string;
  created_at: string;
  target: { kind: "skill"; artifact_uri: string; base_sha256: string; format: "bounded_edits" };
  episodes: Array<{
    run_id: string;
    batch_id: string | null;
    outcome: RunOutcome;
    failure: { category: string; code: string; summary: string } | null;
    checks: Array<{ id: string; pass: boolean; detail: string | null; goal_sha256: string; actual_sha256: string }>;
    trace: Array<{ seq: number; turn: number; step: number; tool: string; outcome: "ok" | "failed" | "timeout" | "denied" | "unknown"; code: string | null }>;
    harness_pins: Array<{ surface: string; uri: string; sha256: string }>;
    metrics: { duration_ms: number; tool_calls: number };
  }>;
}

export interface OptimizerCandidate {
  $schema: string;
  schema_version: "1.0.0";
  candidate_id: string;
  exchange_id: string;
  surface: "skills";
  target_uri: string;
  base_sha256: string;
  title: string;
  objective: string;
  statement: string;
  improvements: Array<{ metric: string; expected_delta: number }>;
  regressions: Array<{ summary: string; severity: "low" | "medium" | "high" }>;
  edits: Array<{ anchor: string; before: string; after: string }>;
}

export interface OptimizerVerdict {
  $schema: string;
  schema_version: "1.0.0";
  verdict_id: string;
  candidate_id: string;
  exchange_id: string;
  verdict: "valid" | "invalid";
  checks: Array<{ id: string; pass: boolean; detail: string }>;
  candidate_sha256: string | null;
  base_sha256: string;
  created_at: string;
}

export interface ExecutionReceipt {
  $schema: string;
  schema_version: "1.0.0";
  receipt_id: string;
  created_at: string;
  candidate_sha256: string | null;
  base_generation_id: string | null;
  candidate_generation_id: string | null;
  effective_composition_sha256: string;
  task_handle: string;
  model: { provider: string; model: string };
  model_patch_sha256: string | null;
  dsh_session_id: string | null;
  event_log_head_sha256: string | null;
  external_state_before_sha256: string | null;
  external_state_after_sha256: string;
  grader_receipt_sha256: string | null;
  source: string;
  business_outcome?: {
    status: "passed" | "failed" | "unknown";
    source: string;
    score?: number;
    earned?: number;
    total?: number;
  } | null;
}

export interface ResetReceipt {
  $schema: string;
  schema_version: "1.0.0";
  reset_id: string;
  action: "reset";
  repository: {
    root: string;
    revision: string | null;
    branch: string | null;
    dirty: boolean;
  };
  stores_digest: string;
  removed: {
    total_files: number;
    outbox: number;
    store: number;
    runs: number;
    clusters: number;
    other: number;
  };
  reason: string;
  actor: string;
  created_at: string;
}
