# DSH Adaptive Loop Charter and v0 Specification

Status: Accepted
Canonical owner: this document
Exact machine owners: [`../schemas/`](../schemas/)

## Purpose and current baseline

Closed-loop, repetitive agent workflows — customer-service-style task classes, ops routines, and benchmarkable business processes with bounded objectives and deterministic graders — already produce useful test, tool, and session evidence, but that evidence is fragmented across transcripts and repositories. Open-ended creative coding is an open-loop problem: with no bounded objective to evaluate against, it is explicitly out of scope for improvement claims. Free-text session feedback is not sufficient for team queries, provenance review, privacy enforcement, or controlled prompt and plugin improvement.

DSH Adaptive Loop (`dal`) provides a local, human-governed improvement loop for those closed-loop workflow classes around DeepSeek Harness (`dsh`). Version 0 captures structured run evidence, evaluates workspace-owned Cordis plugin candidates through dsh's existing HMR lifecycle, stages improvement proposals, and records human decisions. Candidate work happens in an isolated worktree and never modifies dsh core, shared harness configuration, or an installed production plugin.

The 2026-08-29 project rename (recursive-dev-loop → dsh-adaptive-loop) deliberately froze persisted data-format identifiers: the schema namespace `https://recursive-dev-loop.dev/schemas/*` and the recorded evaluator/protocol IDs (`rdl-deterministic-policy-v1`, `rdl-deterministic-clustering-v1`, `rdl-seal-v1`, `rdl_runtime`) are unchanged because renaming them would invalidate ingested, digest-pinned evidence. New code and documentation use `dal`; stored records keep their historical identifiers.

## Users and outcome

- A developer or dsh agent emits one compact feedback record for each feature-change task.
- A team aggregates reviewed records into a durable local store and queries recurring failures and inefficiencies without replaying full transcripts.
- A maintainer reviews observations and proposals before any sandbox evaluation, shared configuration change, plugin installation, external transfer, or candidate application.
- A workbench operator can hot-reload one bounded plugin candidate, run fresh benchmark sessions against that exact generation, and restore the prior generation after rejection.
- A small model loads versioned knowledge capsules instead of repeatedly loading large source trees.

## Goals

- Make task outcomes, evidence, uncertainty, and human review queryable.
- Preserve the source and integrity of every ingested record.
- Reject likely secrets and PII before persistence.
- Model an inspectable improvement lifecycle with explicit human control points.
- Provide a stable JSON boundary for future GEPA and SkillOpt adapters.
- Fit dsh's current project-instruction and project-skill extension points without changing shared harness configuration.
- Use Cordis effect disposal and dsh HMR as the plugin adaptation mechanism instead of maintaining a parallel module loader or patch runtime.
- Evaluate deterministic safety and regression behavior offline before a proposal can advance.

## Non-goals

- Autonomous promotion, automatic production-profile mutation, or changing an evaluator-owned benchmark.
- Running GEPA, SkillOpt, another optimizer, or an LLM from the v0 CLI.
- Installing a dsh plugin or editing `$DSH_HOME`, a dsh profile, or a home-level `cordis.patch.yml`.
- Uploading feedback, telemetry, prompts, source, or evaluation data.
- Replacing dsh's append-only session log or `/feedback` command.
- Capturing raw transcripts, tool arguments, tool output, environment variables, or source-file contents in the team store.
- Proving that an instruction-following model always emits a log. v0 makes omission visible through the required workflow and validation command; lifecycle-level enforcement belongs to a later Cordis integration.
- Treating prompt-injection detection, a model judge, an evaluation score, or human task review as sensitive-action authorization.
- Providing a general shell runner, OS sandbox, package signature verifier, vulnerability scanner, or autonomous rollback executor.

## Domain model

- **Feedback log:** the producer-authored task record defined by [`feedback-contract.md`](feedback-contract.md).
- **Stored record:** an immutable ingestion envelope containing the original feedback log, source provenance, content digest, and versioned secret/PII scan receipt.
- **Observation:** one or more normalized feedback findings that may justify an improvement proposal.
- **Improvement proposal:** a versioned state record that moves through the lifecycle below.
- **Approval decision:** a scoped, expiring human decision for one sensitive action.
- **Knowledge capsule:** compact claims and retrieval pointers bound to versioned sources and freshness checks.
- **Optimizer exchange:** provider-neutral JSON that a future adapter can map to GEPA or SkillOpt without granting application authority.
- **Guardrail action and decision:** a non-executing structured capability request and its immutable deterministic policy result.
- **Evaluation suite and scorecard:** pinned offline fixtures, observed results, metrics, thresholds, provenance, and hard-stop disposition.
- **Controller policy and state:** human-authored observation configuration plus an immutable, digest-pinned estimate of one compatible task batch and harness generation.
- **Candidate generation:** one configured workspace-owned plugin entry plus its bounded source files, identified by a content digest and successful dsh HMR activation sequence.

## Current v0 behavior

### DAL-001 — Structured task feedback

Every feature-change task record contains a change ID, goal, acceptance criteria and outcomes, overall outcome, what worked, what failed, tool/harness/plugin calls, failures or inefficiencies, evidence references, uncertainty, human review and approval state, privacy classification, and redaction metadata. The feedback JSON Schema owns exact syntax; semantic validation owns cross-field rules.

### DAL-002 — End-of-task workflow

The root `AGENTS.md` and project-local `end-task-feedback` skill require a validated feedback log before a feature-change task is reported complete. A completed record has no exception and reports every acceptance criterion as `passed` or `not_applicable`. A blocked or aborted record uses the explicit exception object with a reason, owner, and next action. The workflow never treats omission as successful completion.

### DAL-003 — Local aggregation and provenance

`dal feedback ingest` validates and secret/PII-scans records before writing one immutable JSON file per feedback ID. The stored envelope retains the original source path, source digest, ingestion time, producer provenance, feedback digest, and both scanner rule-set versions. Re-ingesting identical content is idempotent; reusing an ID for different content fails. Query and summary commands read only this local store.

### DAL-004 — Human-governed improvement lifecycle

The machine model supports this ordered lifecycle:

```text
observed -> normalized -> human_reviewed -> proposed -> sandbox_evaluated
         -> awaiting_decision -> approved | rejected
approved -> applied -> measured
```

Each transition appends actor, time, evidence, and notes. `human_reviewed`, `approved`, and `rejected` require a human actor. Every proposal names the exact editable surface it changes (`prompt`, `tool_descriptions`, `skills`, `memory_policy`, `routing`, `stop_retry_logic`, or `harness_code`); targeting an immutable anchor (`evaluator`, `sealed_holdout`, `permissions`, `maximum_budget`, `promotion_policy`, `audit_log`, or `rollback_mechanism`) is invalid at every stage. From the `proposed` stage a proposal must carry a falsifiable prediction with named metric deltas and predicted regressions; prediction is forbidden before `proposed`. Evaluated stages reload the referenced scorecard, verify embedded suite/policy snapshots and current provenance, replay deterministic cases, derive metrics and hard-stop state, and hash the actual candidate artifact. `applied` additionally requires an approved, unexpired decision scoped to `apply_optimization_candidate` and the exact proposal. The CLI exclusively publishes each new state as a direct file below `.dal/proposals/`; it does not overwrite earlier states, execute sandbox evaluation, or apply a candidate.

### DAL-005 — Optimizer adapter boundary

The optimizer boundary exchanges a frozen artifact identity, bounded candidate edits or complete candidate text, dataset references, objective definitions, evaluation evidence, budgets, and provider metadata. The disabled v0 adapter can prepare and validate exchange data but refuses optimization and application. GEPA and SkillOpt remain future providers, not runtime dependencies.

### DAL-006 — Compact knowledge capsules

Capsules carry a semantic version, concise claims, retrieval pointers, source identities, source digests, `checked_at`, and `refresh_after`. Validation checks the capsule schema, freshness, unique claim and pointer IDs, and every available local source digest. A missing, changed, or stale source fails closed; refresh requires explicit source review and a committed capsule update.

### DAL-007 — Developer commands and proof

The repository provides commands to validate, ingest, query, and summarize feedback; validate capsules; verify an approval; record non-executing policy decisions; run offline evaluations; ingest run records; cluster failure evidence; and record improvement transitions. Fixtures cover completed, blocked, aborted, invalid, secret/PII-bearing, safe, adversarial, regression, golden, policy-violation, and declared-sandbox paths. Tests exercise schemas, semantic rules, privacy rejection, immutable ingestion, queries, policy/quarantine decisions, scorecards, workflow transitions, approval scope, capsule drift, run ingestion, and deterministic failure clustering.

### DAL-008 — Sensitive-action approval

An approved human decision is required before an operation changes shared harness configuration, installs a plugin, sends data externally, or applies an optimization candidate. Decisions are action- and scope-specific, expire, and cannot authorize another action by implication. v0 contains no implementation of the first three actions. The isolated HMR workbench is the sole candidate-application implementation and verifies the exact candidate digest at the operation before touching loaded source files.

### DAL-009 — Evaluation and deterministic guardrails

The contract in [`evaluation-and-guardrails.md`](evaluation-and-guardrails.md) treats prompts, repository content, model output, plugins, capsules, and proposals as untrusted data. Version 0 schema-validates and scans them, evaluates explicit capability/sandbox/budget requests with deterministic local policy, records immutable decisions, and runs pinned offline/adversarial/regression suites into scorecards. Hard stops quarantine the exact artifact digest and prevent proposal advancement. Model/judge output cannot override deterministic denial, perform a human-only transition, or authorize a sensitive action. Policy and evaluation commands execute none of the requested actions.

### DAL-010 — Self-improvement loop core

Version 0 implements the deterministic core of the improvement loop plus one approval-bound proposal branch. `dal run ingest` validates and immutably stores one run record: task and change identity, separate harness and business outcomes, structured harness-failure facts, the pinned evaluation context (task set, environment snapshot, tool versions, model, prompt/harness digests, grader version, seeds, context policy digest, inference parameters), workspace artifact digests, usage metrics, evidence references, and privacy metadata. `dal cluster run` groups harness failures by their canonical structured fingerprint and completed business failures by failed deterministic check IDs, keeping the categories separate and skipping completed passing or unknown business outcomes. Cluster identity binds the fingerprint to the run batch: records carry an additive `batch_id`, the cluster id folds the batch in, and `dal cluster run --batch <id>` filters to one batch — so iterative loops re-cluster a growing store cleanly instead of colliding (`CLUSTER_ID_CONFLICT`). The clustering command runs no model, embedding, classifier, or optimizer. The run/improvement/HMR workbench plugin modes ship as unmounted source, and `dal propose run` supplies one exact-approval model branch; Tier 2/3 clustering, optimizer execution, and deeper search remain future work. The governing rule is enforced at the proposal boundary: the agent may propose changes to the editable surfaces, but it cannot control the evaluator, the sealed holdout, its permissions, the promotion policy, the audit log, or the rollback mechanism.

### DAL-011 — Workspace onboarding and user-global install

`dal init [--dir <directory>] [--skill <name>]` scaffolds a workspace: the `.dal/` evidence stores, an `end-task-feedback` skill, workspace instructions, and the evidence-store gitignore rules. It never overwrites existing files and never touches `~/.dsh` or `~/.agents`. `dal install user-global --approval <decision-file>` automates the shared-configuration step: it verifies an exact approved, unexpired `change_shared_harness_config` decision whose scope digest binds the exact template bytes, then writes the skill under `~/.agents/skills/` and the fixed user-global `AGENTS.md` under `$DSH_HOME`, idempotently; differing existing content fails closed with a conflict instead of overwriting. dsh loads the global `AGENTS.md` in every session and discovers the skill in every workspace, so the run/reconcile loop is active everywhere without any manual copying. The inspected dsh instruction loader reads instruction files only (project `AGENTS.md`/`CLAUDE.md`, local overlays, and the fixed user-global `AGENTS.md`); there is no programmatic instruction registry, and plugin-side `agent.inject()`/`agent.steer()` injection is advisory and separate from the instructions baseline.

### DAL-012 — Sealed holdout ceremony

`dal seal init --cases <dir> --output <dir> [--holdout <count> | --holdout-cases <dir>]` commits a train/holdout split: in the workspace mode a random 256-bit seed selects the holdout by HMAC ranking; in the private-source mode the holdout case files come from an operator-owned directory that is never part of the workspace or VCS — the seal records only their digests. A Merkle root over all case digests becomes the dataset digest, and the seed is committed as `sha256(seed || dataset_digest || protocol)` with protocol `rdl-seal-v1`. The seal directory (mode `0700`, files `0600`) holds the commitment, the observed manifest, the sealed manifest, and a one-shot lock; re-initialization is refused while locked. Group/world-accessible seal or holdout directories fail with `SEAL_INSECURE`. `dal seal verify` recomputes the Merkle root — including holdout digests from the private directory when supplied — and fails with `SEAL_DRIFT` if any case changed after sealing. `dal seal reveal --candidate <id>` is one-shot: it records which holdout cases the candidate may be graded against and refuses every later reveal, so a failed candidate cannot convert the holdout into adaptive development. The controller sees only observed case IDs plus opaque holdout handles; a holdout service running under a separate OS principal remains the roadmap step this v0 ceremony approximates.

### DAL-013 — Exactly-once effect sagas

Every side-effecting operation is wrapped in an intent → receipt pair. `dal saga begin --intent <id> --action <effect> --payload <file-or-uri>` records the immutable intent (effect kind, payload reference, payload digest) before any effect runs; `dal saga complete --intent <id> --outcome completed|failed --receipt <file-or-uri>` records the receipt afterwards. Retrying the identical begin or complete is idempotent; a second completion with different content fails with `SAGA_RECEIPT_CONFLICT`, so a resumed or crashed run can never double-complete, double-score, or double-admit. `dal saga status` and `dal saga list` expose pending intents for crash-resume inspection. Idempotency compares the meaningful fields (intent identity, effect kind, payload and receipt digests), not timestamps.

### DAL-014 — Nonce-bound admission receipts

A candidate cannot forge its own admission. `dal admit issue --admission <id> --candidate <file-or-uri>` issues an immutable challenge: a random 256-bit nonce bound to the exact candidate digest. The probe result must echo the admission identity, the candidate digest, and the nonce; `dal admit complete --admission <id> --result <file>` fails closed with `ADMIT_NONCE_MISMATCH` on a forged or stale nonce, `ADMIT_CANDIDATE_MISMATCH` on a different candidate, and `ADMIT_MISSING` for an unissued admission. A second completion with different content fails with `ADMIT_RECEIPT_CONFLICT`. `dal admit status` reports `pending`, `passed`, or `failed`. In v0 the probe itself is any deterministic verifier the operator runs; the nonce-binding ceremony is what ships, and the sandboxed loader probe (the future executor's bwrap-style boot check) will emit these result records.

### DAL-015 — Governed proposer

`dal propose prepare --clusters <dir> [--runs <dir>] --output <payload-file>` builds a sanitized proposer payload: cluster fingerprints, member counts, and capped representative failure summaries — never raw traces, run contents, or secrets — and prints its digest. `dal propose run --clusters <dir> --approval <decision> --workspace <dir> --output <draft-file> [--provider <p>] [--model <m>]` verifies an exact approved, unexpired `send_data_externally` decision whose scope digest equals the prepared payload digest, then invokes the configured model (default `deepseek-v4-flash` on `deepseek-official` via a `dsh --profile headless` session with a model patch overlay) and writes the reply as a schema-validated proposal draft on an editable surface. Replies on ineditable surfaces or without JSON fail with `PROPOSE_REPLY_INVALID`; the draft carries the payload digest and cluster provenance, and promotion into the proposal lifecycle remains a human step. The proposer is one branch of the bounded search: deterministic evaluation is the value function and human promotion is the selection policy.

### DAL-016 — Bounded search branches

Drafts become branches in an archive, not a single lineage. `dal branch record --branch <id> --draft <file> [--parent <branch-id>]` records an immutable branch with parent linkage (a missing parent fails with `BRANCH_MISSING`); `dal branch evaluate --branch <id> --task <task-file> --state <state-file> [--effects <effects-jsonl>] [--receipt <execution-receipt>]` grades a candidate state and, when declared by the task, evaluator-owned effect evidence with the deterministic task grader, then records the verdict as the value function (score `1` pass / `0` fail, checks attached). An evaluation is provenance-valid only with an execution receipt that binds this exact graded state (`external_state_after_sha256`), any supplied effect log (`business_effect_log_head_sha256`), names this exact task (`task_handle`), and carries this exact verdict digest (`grader_receipt_sha256`) — any mismatch fails with `BRANCH_RECEIPT_MISMATCH`. `dal branch stats` derives visits and mean scores from receipt-bound evaluations only; provenance-invalid evaluations are retained but never influence selection. `dal branch select [--c <exploration>]` applies UCB1 — unexplored branches are selected first, then the branch maximizing `mean + c·sqrt(ln(total)/visits)` — and returns the suggested branch to expand. Rejected branches are retained in the archive as negative evidence; expansion is the governed proposer, promotion is the human proposal lifecycle. This is the select/expand/evaluate/retain skeleton; deeper MCTS rollouts remain future work.

### DAL-017 — Confined verifier executor

`dal verify run --action <action-file> --command <command-line> [--workspace <dir>]` executes the first real boundary: it re-validates the guardrail action, requires an `allowed` decision at the operation, refuses `run_local_verifier` requests without a sandbox declaration or with network declared, then confines the command through the **dsh sandbox seam** (`@deepseek-ai/dsh-sandbox` `0.1.1-rc.2` + `dsh-sandbox-local` `0.1.1-rc.2` on Cordis `4.0.1`): the provider selects the platform runner (Seatbelt on macOS, bwrap then Landlock on Linux, the ACL runner on Windows), returns the confined argv plus enforcement completeness and the backend's denial dialect, and fails closed with `SANDBOX_UNAVAILABLE` when no backend works. The run never falls through unconfined; budgets from the action bound the timeout and captured output; the reported backend and enforcement come from the provider, not from dal's assumptions. The seam confinement was executed on macOS (`DAL_SANDBOX_PROBE=1`) with the deterministic grader passing inside the sandbox and an out-of-roots write denied in the backend's own dialect.

### DAL-018 — Evidence reset and rebaseline

### DAL-019 — Run and improvement plugin modes

The loop ships as one dsh bundle (`@lunarmoon26/dal-modes`, a package declaring `dsh.bundle.patch`) with two separable modes, so improvement code never runs in a recording-only hot path:

- **Run mode** (`@lunarmoon26/dal-run-record`): a persistence-style plugin that subscribes to the dsh `session/event` firehose, buffers fire-and-forget (observer failures are contained and never fail an append), and drains on awaited `session/flush` plus best-effort session disposal into workspace-local run records under `.dal/runs/`. Records carry only privacy-safe projections: session identity, outcome from turn-end reasons, failure facts from tool-result errors (names and codes only), per-tool call counts, summed token usage, the provider/model route, `sha256` digests of the system prompt and the workspace policy file, and the environment snapshot. When a launcher-owned `runtimeGeneration` service exists before `session/created`, the recorder also binds its precomputed manifest/evidence identity and legacy harness pins; checkpoints and transition-spanning sessions remain explicitly unstable. Raw prompt text, message content, tool arguments, tool results, and secret configuration values are never stored — only privacy-safe digests, references, or counts.
- **Improvement mode** (`@lunarmoon26/dal-improve-tools`): workbench tools registered on `ctx.tools` that run the same deterministic dal CLI the operator runs: cluster the run store, prepare a sanitized proposal payload (digest only), summarize stored feedback, evaluate a branch against the deterministic grader, and dry-run the reset status. The tools expose nothing approval-gated: no `propose run` (model call), no `reset execute`, no seal reveal, no sensitive action — promotion stays a human CLI step.

The bundle ships with the recorder row enabled and the improvement-tools and HMR-candidate rows disabled; a workbench profile enables and configures the required rows in its own `cordis.patch.yml` layer, and a run-only profile keeps them off. Mounting any mode into a profile is an approval-gated `install_or_mount_plugin` operation (bundle sources stay workspace-VCS-owned and digest-pinned); the CLI needs no dsh profile to work. Deeper dsh integration (shared run-store location across machines, the separate-principal holdout service, MCTS rollouts) remains roadmap work.

The bundle also names `@lunarmoon26/dal-unknown-effect-guard` as a disabled G2 candidate. Its pre-execution gate claims a workflow idempotency key while an effect is in flight, retains the lock when the observed result is `unknown`, and releases it only after a successful status query reports `success` or `definite_failure`. State is scoped by agent and stores no arguments or results. Repository source and unit tests do not authorize deployment: plugin mount and optimization-candidate application remain separate exact approval operations, and rollback is the prior profile generation.

`dal reset status [--workspace <dir>]` reports a dry run of what a reset would remove: the `.dal/` store file counts, a digest manifest over the stores, the git revision, and every blocking condition. `dal reset execute [--workspace <dir>] --reason <text> [--actor <id>] --acknowledge remove-all-evidence` removes the entire `.dal/` directory and treats the current workspace snapshot — the skills, plugin sources, instructions, and harness files at HEAD — as the new starting point: the pre-reset revision and a digest manifest of the removed stores are recorded in a schema-validated reset receipt written to `.dal/resets/`, and empty stores are re-scaffolded so the loop keeps running. Deterministic checks may block but never authorize: the exact acknowledgement token is required (`RESET_ACKNOWLEDGE_REQUIRED`), uncommitted changes under the tracked evidence stores fail closed (`RESET_DIRTY`), a non-directory `.dal` is refused (`RESET_INSECURE`), and secret or PII material in the reason fails the privacy scan. Reset is not one of the four sensitive actions: it deletes only local workspace evidence, committed evidence stays recoverable in VCS history, and the operator commits the removal as the application step.

### DAL-020 — Container-hosted harness execution

The local e2e and benchmark paths can run the harness inside a pinned container instead of the host's dsh installation: `dal verify run --runner docker` and `dal propose run --runner docker` re-execute the same fail-closed dal paths inside the `deploy/docker/` image (`@deepseek-ai/dsh@0.1.1-rc.2` pinned on `node:24-slim` with `bubblewrap`), with the workspace bind-mounted at `/workspace` and `--network none` hardcoded. The in-container CLI re-validates the guardrail decision at the operation and confines through the image's Linux sandbox chain (bwrap → Landlock); an unreachable daemon fails closed with `DOCKER_UNAVAILABLE`, a path escaping the workspace mount fails with `DOCKER_PATH_DENIED`, and only the policy-listed environment names (default `DEEPSEEK_API_KEY`) pass into the container. The image name, extra run flags, and env allowlist live in the policy (`docker_image`, `docker_run_flags`, `docker_env_names`); the in-container sandbox probe is the required proof before trusting the runner (see `deploy/docker/README.md`). Nothing global is installed for container runs: no host profile, `~/.dsh/AGENTS.md`, or `~/.agents` change is needed.

### DAL-021 — SkillOpt-shaped optimizer adapter (prepare/evaluate-only)

The optimizer exchange ships as a deterministic, prepare/evaluate-only adapter behind the existing exchange schema, keeping the v0 no-optimizer boundary intact: `dal optimize prepare --skill <path> [--store <dir>]` builds a sanitized SkillOpt training set from stored run records — business failures first, harness failures second, capped at 64 episodes, each retaining both outcome labels, failure facts, per-check grader deltas (`goal_sha256`/`actual_sha256` + deterministic `detail`), the ordered trace projection, harness pins, and batch linkage — and emits the `provider_hint: skillopt` exchange envelope whose training dataset points at the written set. `dal optimize evaluate --exchange <file> --candidate <file> --output <verdict-file> [--candidate-out <path>]` runs the deterministic validation gate over a bounded-edits candidate: exchange match, skills-only surface, target URI, base digest, edit count and size bounds (the SkillOpt gradient clipping), sequential anchor resolution against the base skill, and the reconstructed candidate digest; a passing gate may write the reconstructed skill text for human review. Neither half calls a model, sends data, or applies anything — the reflect step and rollout stay approval-gated and human-promoted. Candidate text is secret/PII-scanned before any check runs.

### DAL-022 — Benchmark measurement integrity

The tau-style benchmark separates execution health from task quality: a completed harness attempt records `outcome: succeeded` even when `business_outcome.status` is `failed`; runtime failures and business failures validate and cluster independently, and optimizer episodes retain both labels. A failed business outcome must name at least one failed deterministic check. Workflow task syntax is owned by `workflow-task.v1`: goal state, policy reference, and required/forbidden effect rules are evaluator-only. Grader `2.0.0` requires explicit effect-log evidence whenever rules exist, so an unchanged refusal state passes only with the matching successful `refuse_request` and no forbidden attempt. Branch evaluations accept `--effects`, persist its reference/digest, and require receipt binding for effect-aware provenance.

Approval-bound e2e attempts use a three-container topology. The candidate receives a minimal read-only workspace containing only its projected task, policy, candidate skill, and exact composition patch. A separate service container is the sole writer of a checksummed append-only effect journal and derives state by fail-closed replay; seed replacement fsyncs both file and parent directory. The candidate reaches state only through typed endpoints. A grader on a separate internal network mounts an attempt-staged full task and obtains an authenticated state/effect snapshot. The transmission manifest includes rollout count, full evaluator-task digests, driver-source digests, and the exact stable rendered composition-patch text; it is published immutably after approval, and every attempt rehashes current inputs against it after staging but before the model call. All three containers run by the approved immutable image digest rather than the mutable tag. E2e execution receipts and summaries bind the manifest digest in addition to journal, staged workspace, image, composition, state, verdict, candidate/model/generation, explicit isolation identities, and the persisted run-record path/digest. Comparison rejects missing, duplicated, reassigned, or digest-mismatched receipt/run evidence; it recomputes task and overall metrics from receipt-bound attempt outcomes rather than trusting summary counters. The shared execution-receipt schema remains usable by non-e2e branch evaluation, so manifest, isolation, and run IDs are optional at schema level but mandatory in this e2e verifier. Comparison also rejects benchmark drift, same-generation candidate drift, or a simultaneous candidate/model change while permitting same-candidate provider matrix cells. Generation labels are limited to `g0` and `g1`; `g2` is rejected while its guard remains source-only. No full model batch runs without a matching unexpired `send_data_externally` decision.

### DAL-023 — Run-to-run controller observation foundation

`dal control estimate --policy <controller-policy> --batch <batch-id> [--runs <dir>] [--store <dir>]` creates one observation-only controller state from immutable run records. The controller policy names one logical task class, exact task set, the versioned `dal-wilson-score-v1` estimator, and uniquely sourced harness, business, or deterministic-check proportion metrics with target, deadband, and minimum sample count. Failure-cluster member counts are never treated as success-rate denominators.

The estimator validates and privacy-scans policy and runs, selects the exact non-null batch and task set, and requires one normalized measurement context and one pinned harness generation. Measurement context binds environment, tool versions, model, grader, context-policy digest, and inference parameters; generation identity binds prompt, harness, model-patch, and harness-pin digests. Different seeds may contribute observations, but mixed context, mixed generation, duplicate run/check identity, or a missing harness digest fails closed. Each metric records successes, failures, exclusions, mean, a two-sided 95% Wilson score interval, and evidence sufficiency. A state is `ready` only when every configured denominator reaches its minimum; insufficient evidence is a valid state, not permission to adapt.

State identity binds the complete canonical snapshot, including the immutable policy/run inputs and derived estimates. Estimate time and input-set digest derive from the sorted run inputs, so an identical retry is idempotent and wall-clock time cannot change the record. States publish exclusively under `.dal/control-states/` by default or the explicit `--store`. The controller state is evidence only: it does not invoke a proposer, select a branch, mutate a budget, transition a proposal, run a sandbox, call a model, send data, apply a candidate, promote a generation, or execute rollback. The proposal lifecycle and operation-time guardrail/approval boundaries remain authoritative. PI control, hysteresis, dwell time, anti-windup, edit-response learning, predictive selection, canary, and rollback control remain future work in [`../ROADMAP.md`](../ROADMAP.md).

### DAL-024 — Runtime generation attestation

The runtime generation contract separates immutable identity from appraisal. `runtime-generation-manifest.v1` binds the launcher artifact, a secret-omitting effective-config projection, ordered Loader composition, resolver receipts, and artifact closure. Manifest identity is SHA-256 over RFC 8785 JCS bytes under the fixed `rfc8785-jcs-sha256-v1` profile; timestamps and evidence results are excluded. `runtime-generation-evidence.v1` separately records declared, observed, or verified assurance plus monotonic session-transition evidence. Exact semantics and the upstream producer boundary live in [`runtime-generation-attestation.md`](runtime-generation-attestation.md).

`run-record.v1` adds optional `runtime_generation` linkage and an optional explicit `record_stage` without changing the meaning of `context.harness_sha256`. The linkage binds a session ID digest as well as manifest/evidence identity. The recorder consumes an optional launcher-owned service synchronously at `session/created`, never late-binds, marks checkpoint records unstable, and marks a successfully persisted final disposal record stable only when the provider identity remains installed and its transition sequence has not changed. A failed mutation or rollback still increments the sequence. Missing or malformed services produce unattested records rather than inferred proof; unknown pin fields are never copied. Pinned DSH treats `session/disposed` as an observe-only event and does not await listener promises, so it cannot guarantee final-record availability before process teardown; absent final output fails closed and an awaited launcher teardown boundary is part of the upstream producer requirement.

Controller policy/state `schema_version: 1.1.0` adds runtime qualification and identity while the same v1 schemas continue validating historical `1.0.0` snapshots without silently upgrading them; a legacy policy cannot produce a new estimate. Before state publication, explicit checkpoint records are excluded; every selected final/historical run must be stable and policy-qualified, bind a unique evidence session digest, and use canonical repository-local evidence and manifest files opened through no-follow, non-blocking, path/inode/metadata-checked descriptors; platforms lacking the required native flags fail closed. The evidence and referenced manifest are schema/semantics/privacy validated, and the manifest digest is recomputed. The selected batch must share one runtime manifest in addition to the existing prompt, harness, model-patch, and harness-pin generation fields. Current DAL code validates and consumes this evidence but does not claim that DSH emits it: authoritative effective Loader configuration, resolver URLs, artifact closure, transition ownership, and readiness require the pinned DSH launcher/Loader additions documented in the focused contract.

### DAL-025 — HMR plugin candidate loop

The workbench mounts `@lunarmoon26/dal-hmr-candidate` outside the editable plugin subtree and configures one loaded plugin entry, a bounded list of existing source files, one fixed staging directory, one fixed approval file, one approval scope, and the DSH version/profile under an isolated linked git worktree. `dal_candidate_prepare` copies the current files into staging; the agent edits only those inactive copies. `dal_candidate_status` reports the deterministic staged digest and base git tree so a human can issue an exact decision. `dal_candidate_apply` runs `dal approval verify` for that digest at the operation, copies the approved bytes into the watched paths, and waits for dsh's success-only `hmr/reload` event naming the configured entry. A syntax error, failed activation, unrelated reload, timeout, or approval mismatch cannot admit the candidate and restores the snapshotted source bytes. A successful admission binds only subsequently created sessions to the candidate id, digest, base git tree, DSH version/profile, and HMR sequence. A checkpoint is never evaluation-eligible; a final record is eligible only when its session was observed at `session/created`, its starting generation was admitted, and no later successful reload occurred before that record.

`dal_candidate_reject` restores the exact snapshotted files and waits until HMR reports the prior digest active again. The coordinator accepts no arbitrary source, staging, approval, or command paths after activation, creates no plugin, edits no profile, and cannot promote a candidate. Promotion is the explicit human git review and commit of the isolated worktree; production mounting remains a separately approved operation. Skills and `AGENTS.md` remain proposal surfaces, but the HMR path specifically evaluates Cordis plugin implementation and imported configuration modules. The loop consumes public HMR events and does not patch dsh core, Loader, HMR, or Node's module hooks.

## Constraints and assumptions

- Node.js and ESM align with dsh's implementation conventions. TypeScript is the implementation language.
- Records are JSON and remain portable across local filesystems and future adapters.
- A local filesystem can still be copied or read by other processes with user access; the project is not an encrypted vault.
- Secret detection is defense in depth, not proof that content is non-sensitive. Producers must summarize rather than paste raw execution data.
- Team aggregation in v0 means a shared or collected local directory. Concurrent distributed writers and remote synchronization are not provided.
- dsh is in developer preview; every dsh-derived capsule has an explicit refresh date and pinned source identity.

## Acceptance criteria

1. Given valid completed, blocked, and aborted fixtures, schema and semantic validation accepts each explicit path.
2. Given a completed record with a failed or unrun acceptance criterion, validation rejects it.
3. Given likely credential material anywhere in a candidate record, ingestion persists nothing and reports the matching secret rule.
4. Given one valid record, ingestion writes an immutable envelope and an identical retry is idempotent; conflicting content under the same feedback ID fails.
5. Given stored records from several producers, query filters by change, outcome, privacy tag, and date; summary reports outcome and inefficiency counts.
6. Given a capsule whose local source changes or whose refresh date passes, capsule validation fails.
7. Given an approval for another action, scope, decision, or expiry window, sensitive-action verification fails.
8. Given an improvement transition requiring human control, an agent actor or missing approval is rejected.
9. Running every README quick-start and verification command produces the documented result without contacting an external service.
10. A safe local guardrail request is allowed and audited without executing its requested operation.
11. Likely secret and PII fixtures fail before persistence without printing the matched value.
12. An unapproved candidate-application request is rejected and the target remains unchanged.
13. The offline evaluation suite contains every required fixture class, computes the documented metrics, and hard-stops on any dangerous allow or golden regression.
14. A hard-stop scorecard cannot support `sandbox_evaluated`, `approved`, or `applied` proposal progression.
15. Dependency and command inspection confirms no model judge, generic network client, policy daemon, plugin installer or mounter, optimizer runner, or arbitrary candidate applier ships; the fixed user-global installer and purpose-specific proposer/e2e/HMR executors independently require exact approvals at their operation boundaries.
16. A reset without the acknowledgement token or with uncommitted evidence fails closed and removes nothing; an acknowledged reset removes the evidence stores, re-scaffolds empty stores, and records a validated reset receipt with the pre-reset revision.
17. The mode bundle ships recorder-on/tools-off; run-mode records validate against the run-record schema and contain no raw prompt, message, argument, or result content; the workbench tool set exposes no approval-gated operation.
18. The docker runner fails closed when the daemon is unreachable or a path escapes the workspace; the in-container probe passes the deterministic grader through the bwrap/Landlock chain and denies out-of-roots writes; host dsh state is untouched.
19. The optimizer adapter prepares a schema-valid, sanitized SkillOpt training set from stored run records and deterministically validates bounded-edits candidates (rejecting wrong surfaces, base digests, lost anchors, oversized edits, and secrets) without any model call or application.
20. A completed benchmark attempt preserves `outcome: succeeded` independently of its business verdict; failed business outcomes require a failed check; refusal tasks fail without matching effect evidence; journal corruption fails closed; candidate topology arguments expose neither repository nor oracle mounts; attempts revalidate and receipt-bind an immutable approved manifest and persisted run record; approved containers run by image digest; comparison rejects duplicated evidence, inconsistent derived metrics, frozen-context drift, or candidate/model confounds; `g2` labels are rejected; and the disabled G2 guard retains unknown or errored same-key locks until terminal status evidence.
21. Controller estimation over one compatible batch publishes a deterministic immutable state with versioned Wilson intervals and explicit exclusions; mixed contexts, mixed or unpinned generations, duplicate identities, ambiguous metric sources, and tampered derived fields fail closed; insufficient samples remain non-authorizing evidence; and the command performs no proposer, model, network, sandbox, transition, budget, application, promotion, or rollback action.
22. Runtime generation manifests digest deterministic closed I-JSON with RFC 8785 JCS; evidence keeps assurance and session-transition appraisal separate; run recording never late-binds or qualifies checkpoints/transition-spanning sessions; controller enrollment validates repository-local evidence and its manifest, preserves the legacy harness pin, and rejects absent, unstable, under-qualified, mixed, unavailable, or digest-mismatched runtime generations.
23. Given a configured workspace-owned plugin entry, a successful matching HMR reload admits its bounded source digest; failed or unrelated reloads do not, checkpoints and sessions spanning a later reload are ineligible, and rejection restores and reactivates the exact prior bytes without modifying dsh core or a shared profile.

## Evidence plan

- Automated: TypeScript type checking, Vitest suites, schema validation, privacy precision/recall fixtures, guardrail policy tests, offline scorecards, CLI integration tests, capsule source-digest checks, and a documentation command smoke.
- Manual: review field semantics, threat assumptions, source citations, current/future labels, and the root workflow wording.
- Not proved in v0: DSH production of authoritative runtime-generation manifests/evidence, dsh lifecycle-level enforcement, optimizer quality, controller improvement or stability, sandbox isolation, multi-machine durability, or model compliance with project instructions.
- Not proved in v0: DSH production of authoritative runtime-generation manifests/evidence, dsh lifecycle-level enforcement, optimizer quality, controller improvement or stability, production-profile promotion, sandbox isolation, multi-machine durability, or model compliance with project instructions.

## Future owner

Unimplemented work belongs in [`../ROADMAP.md`](../ROADMAP.md). Requirement closure belongs in [`requirement-evidence.md`](requirement-evidence.md) once implementation evidence exists.
