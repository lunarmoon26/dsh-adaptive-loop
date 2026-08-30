# Evaluation and Guardrails Contract

Status: Accepted
Canonical behavior owner: this document
Exact syntax owners: [`../schemas/guardrail-action.v1.schema.json`](../schemas/guardrail-action.v1.schema.json), [`../schemas/guardrail-decision.v1.schema.json`](../schemas/guardrail-decision.v1.schema.json), [`../schemas/evaluation-suite.v1.schema.json`](../schemas/evaluation-suite.v1.schema.json), and [`../schemas/evaluation-scorecard.v1.schema.json`](../schemas/evaluation-scorecard.v1.schema.json)
Policy values: [`../config/policy.v1.json`](../config/policy.v1.json)

## Purpose and trust posture

`dal` treats repository text, feedback, model output, optimizer output, plugin metadata, and evaluation results as untrusted data. None of them can grant a capability. A structured request must pass deterministic policy at the operation boundary, and sensitive operations additionally require an exact human approval. Version 0 evaluates and records requests but provides no network client, general shell executor, plugin manager, shared-configuration writer, optimizer runner, or candidate applier.

Guardrails reduce risk; they do not prove that arbitrary content is safe. Prompt-injection detection and model grading are supplemental evaluations, never authorization mechanisms.

## Threat model

| Threat | Failure mode | v0 prevention or detection | Residual risk and owner |
| --- | --- | --- | --- |
| Prompt injection | A repository document, capsule, fixture, or model output tells an agent to ignore policy or request more tools | Content is data; only schema-valid capability requests reach deterministic policy. Untrusted input cannot change policy, approvals, tool identity, or scope. Adversarial fixtures test instruction-like content. | Novel instructions can still influence model reasoning before the boundary. The harness owner must keep enforcement outside prompts. |
| Malicious or untrusted repository content | Checked-in scripts, instructions, symlinks, or fixtures induce execution, path escape, or data access | Requests declare `input_trust`; local reads and writes are constrained to policy-owned URI roots; v0 never executes text from a request. Capsule digests fail closed. | This CLI is not an OS sandbox. A future executor must provide filesystem isolation and symlink-safe path resolution. |
| Secret or PII leakage | Credentials or identifying data enter feedback, capsules, audit records, scorecards, logs, or external requests | Schema validation plus deterministic secret and PII scanning runs before persistence. Unsafe values are rejected, not logged. Explicit typed redaction markers and metadata are required. External transfer is unavailable. | Pattern detection has false positives and false negatives. Producers and human reviewers remain responsible for minimization. |
| Unsafe shell, file, or network action | Destructive commands, writes outside the workspace, or unapproved network calls execute | Policy evaluates semantic operation IDs rather than raw shell strings. Destructive shell, outside-workspace writes, and all network capability are denied in v0. Allowed verifier requests require network-denied sandbox declarations and bounded writable roots. | `dal policy check` records intent; it does not sandbox another process. The future executor must independently enforce the same decision. |
| Plugin supply-chain compromise | A malicious, substituted, or vulnerable plugin gains dsh/Cordis lifecycle access | Plugin installation and mounting are unavailable and approval-gated. Proposed artifacts require exact package/version/digest provenance, offline evidence, and no active quarantine before a future integration may proceed. | v0 does not verify signatures, SBOMs, or vulnerabilities. A future installer must add pinned, separately evaluated supply-chain verification. |
| Capability escalation | A read-only actor or tool converts one approval into broader access | Capabilities, action, scope, target digest, sandbox, and budget are explicit. Decisions match exactly; approvals do not imply another action or scope. Untrusted content cannot author policy. | Local actor IDs are assertions, not cryptographic identities. Organizational authentication remains external. |
| Self-improvement reward hacking | A proposal optimizes the measured score while degrading safety or hidden behavior | Objectives, held-out fixtures, guardrail metrics, regression cases, and application authority are separate. An optimizer cannot edit its evaluator, policy, approval, or scorecard. Candidate application is unavailable. | Finite suites can be gamed. Maintainers own hidden-case rotation, qualitative review, and later production monitoring. |
| Evaluation contamination | Candidate authors see or train on held-out cases, or test data leaks into reflection input | Suites label fixture class, pin fixture digests, declare contamination review, and keep regression/golden cases distinct from optimization datasets. Unknown or detected contamination is a hard stop. | v0 cannot prove a model never saw public or local data. Human review records the known boundary. |
| Regressions | A plugin, skill, capsule, or optimizer proposal improves one metric while breaking behavior or policy | Golden/regression fixtures, policy-violation tests, baseline comparison, and post-change regression rate are mandatory scorecard inputs. Any hard-stop regression quarantines the artifact. | Offline fixtures do not prove dsh runtime, OS sandbox, or production behavior unless that integration is executed. |

## Enforcement order

Validation and privacy failures stop immediately. Deterministic policy may record multiple applicable rules, but the strongest effect wins (`denied` before `requires_human_approval` before `allowed`). Later evidence cannot override a deterministic denial.

| Order | Layer | Enforced behavior | v0 evidence |
| --- | --- | --- | --- |
| 1 | JSON Schema | Unknown versions, fields, enum values, and malformed identities fail | AJV 2020-12 validation for every persisted artifact |
| 2 | Secret and PII handling | Every string leaf and source JSON is scanned; likely sensitive data fails before write; typed redactions must resolve | Secret/PII adversarial fixtures and no-write tests |
| 3 | Deterministic action policy | Explicit capability, operation, target trust, local URI root, and deny rules produce `allowed`, `denied`, or `requires_human_approval` | `dal policy check` and immutable decision envelope |
| 4 | Sandbox boundary declaration | Local verifier requests require a non-`none` sandbox, denied network, and policy-bounded writable roots | Sandbox policy fixtures; no claim of OS isolation |
| 5 | Rate and budget limits | Request call, time, byte, and network budgets cannot exceed policy; new audit decisions are rate-limited per local window | Policy-limit tests and scorecard cost fields |
| 6 | Provenance and quarantine | Request, policy, approval content, fixtures, target, and result carry SHA-256 identities; audit and scorecard records publish immutably; hard-stop digests in the policy-configured evaluation store fail closed | Conflict/idempotence/staleness, quarantine lookup, and digest-drift tests |
| 7 | Human approval | Sensitive action, exact scope, candidate digest, decision, and expiry are independently verified | Wrong-action/scope/digest/status/expiry tests |

`allowed` means the structured request fits a v0-safe local capability. It does not execute anything. `requires_human_approval` is a rejection at the current boundary, not provisional permission. Even a valid approval cannot enable a capability whose executor does not exist in v0.

An identical action-ID retry is idempotent only while dynamic prerequisites still produce the same rule set, approval digest, and effect. New quarantine evidence or changed/expired approval state makes the old immutable decision stale; the caller must issue a new action ID rather than reuse an earlier allow.

## Tool and capability policy

Requests use stable operation IDs, not shell command strings or arguments. Policy allows only:

- local reads through repository-scoped references;
- writes of validated records under policy-owned `.dal/` stores;
- deterministic local schema, privacy, policy, capsule, test, typecheck, and build verification with network denied;
- read-only query and summary operations.

Policy denies destructive shell intent, writes outside policy-owned roots, network access, privilege escalation, shared configuration changes, plugin management, and candidate application. Sensitive denied capabilities map to the separate approval action defined in [`governance.md`](governance.md), but v0 still returns `denied` after a valid approval because no executor ships.

## Optional dsh enforcement adapter design

Status: Proposed and unimplemented. The current CLI and scorecard schemas remain local, deterministic, and independent of dsh.

The inspected DSH version exposes three tool waterfalls, followed by an immutable result notification. A future DAL integration uses each phase only for the concern it can enforce:

| DSH phase | Proposed guardrail responsibility | Required fail-closed behavior |
| --- | --- | --- |
| `tools/pre-execute` waterfall | Resolve canonical tool identity, inspect command/path intent, evaluate policy and quarantine, and return allow/deny/ask | Never rewrite logged arguments. Recheck path, shell, and sandbox policy at the capability operation that performs the effect. |
| `tools/execute` waterfall | Apply cooperative deadline, aggregate call metrics, and bind execution receipt identity | Preserve downstream cancellation and make wrapper order explicit. Do not claim process termination when a provider ignores its signal. |
| `tools/post-execute` waterfall | Scan final content/value, replace likely secret/PII with a denied safe result, and enforce byte/token truncation before model reuse | Persist rule IDs, omitted counts, and content digests rather than matched values. Post-processing cannot reverse a side effect that already happened. |
| `tools/result` emit | Observe the frozen final outcome for counters and diagnostics | Observation only: it cannot rewrite, deny, approve, or serve as a fourth waterfall. |
| Durable `tool/call` and `tool/result` events | Bind model-visible call/result order into a trajectory | Detect missing pairs, event gaps, execution after denial, and inconsistent identities; do not infer unrecorded side effects. |

A repeated-failure and aggregate-budget plugin derives bounded state from durable session events and applies the next hard decision at `agent/pre-step` or `tools/pre-execute`. `session/event` observers run after commit and cannot veto the event they receive. `agent.steer()` or `agent.inject()` may add a logged advisory; they cannot replace deterministic cancellation or denial. Current DSH evidence supports per-call cooperative timeouts, per-request output-token limits, subagent depth limits, and an advisory identical-tool-call reminder, but not a global turn/token/time or repeated-failure hard budget.

Permission escalation uses DSH's optional one-shot `approval/request` waterfall. Missing or failing answerers deny. ACP and the API proxy demonstrate independent answerers, but no Slack, webhook, or ticket implementation was found. Because a DSH approval request omits tool arguments, a future DAL answerer must join trusted operation metadata and independently verify the exact DAL action, scope, target digest, decision, and expiry. A DSH one-shot allowance never implies approval for external transfer, plugin installation, shared configuration, or candidate application.

DSH sandbox modes and platform runners are evidence inputs, not universal guarantees. `danger-full-access` is unconfined; Windows and older Landlock enforcement can be partial; macOS relies on deprecated Seatbelt tooling; and the inspected sandbox interface does not promise network isolation. An evaluation may claim only the runner, enforcement completeness, filesystem/process checks, and network control it actually exercised.

## Evaluation harness

### Bounded benchmarks for closed-loop workflows

Open-ended creative coding is an open-loop problem: no bounded objective, no deterministic acceptance test, no reusable state transition — and therefore no honest RSI claim. Recursive self-improvement belongs to closed-loop, repetitive workflow classes where every run has an externally fixed objective, an observable state transition, and a deterministic grader. The evaluation design is bounded accordingly:

- **Task class first.** A benchmark exists only for a named workflow class with a stable grader (tests, schema checks, policy decisions, end-state verification). Each class gets its own suite; results are never blended across classes.
- **Externally fixed objective and process.** The objective, grader version, holdout set, and evaluation process are anchor-owned; the system under improvement never edits them. The honest claim is bounded empirical self-improvement under an externally fixed objective and evaluation process — not open-ended recursion.
- **Closed-loop observability.** Every run records the state transition and the graded outcome; improvement means the distribution over graded outcomes improves on held-out cases, not that one run looked good.
- **Budget-bounded.** Suites carry case, time, tool, and cost budgets; the search over changes is bounded by the same limits.

Level 0 in-run retries are not persistent learning and are not counted as improvement; only cross-run evidence (Level 1 and above, per the research-note ladder) may enter a proposal.

### Adopted community hardening

These rules were adopted from the source audit of community DSH RSI frameworks (see the research note) and apply to every future model-based or sandbox-evaluated stage:

- **One-shot sealed reveal.** A sealed-holdout reveal is single-use: a failed reveal cannot trigger "try the next-best candidate," which would silently turn the holdout into adaptive development. The sealed set stays invisible to search until the promotion decision. Implemented in v0 as `dal seal init|verify|reveal` (Merkle-root dataset digest, committed seed, one-shot lock and reveal, drift detection, private holdout source directory with `SEAL_INSECURE` permission guards); a holdout service under a separate OS principal remains future work.
- **Nonce-bound admission receipts.** A candidate or plugin cannot forge its own "booted OK" record: admission probes bind a random nonce to the boot signal, and early, duplicate, or forged control records fail closed. Implemented in v0 as `dal admit issue|complete|status`; the sandboxed loader probe emitting these results is future executor work.
- **Exactly-once effect sagas.** Every sandbox evaluation follows intent → effect → receipt with idempotency keys; a resumed run cannot double-pay, double-score, or double-admit. Implemented in v0 as `dal saga begin|complete|status|list` with immutable intent records and conflict-refusing receipts.
- **Rubric isolation with drift re-marking.** Where an LLM scorer exists, the executor never sees the rubric and an independent reviewer grades evidence only; rubric material is protected at rest and its key is never same-principal-readable. Any change to a case statement or rubric after calibration re-marks the case via content hash instead of silently reusing stale scores.
- **Code-owned scoring over LLM leaf judgments.** LLM per-cell scores may feed aggregation, but the accept/reject decision is code-owned: strict non-regressive acceptance, failed-cell exclusion (a failed cell is not zero), and fixed-seed paired statistics. A mean without variance remains inadmissible.
- **Inverse-edit rollback with audit links.** Rollback rebuilds the exact inverse of each applied edit from recorded before/after state, never an LLM re-guess, and the rollback itself is a recorded event with a `rollbackOf` provenance link.
- **Generation switch with a bootable previous slot.** Profile deployment uses an acceptance-gated atomic switch between generations, with the previous generation kept bootable for one-command rollback; acceptance includes the deterministic suite, not just a launch smoke test.

### Suite composition

An offline evaluation suite pins every fixture path and digest and contains all of these classes:

- **offline fixtures:** deterministic valid inputs with no provider or service;
- **adversarial/red-team fixtures:** prompt-injection-shaped text, malicious capability requests, path/network escapes, secrets, and PII;
- **regression/golden cases:** accepted output and policy behavior that must remain exact;
- **policy-violation tests:** explicit denied capability, missing approval, wrong scope, expired decision, and budget cases;
- **integration/sandbox tests:** local CLI/store boundaries and declared sandbox rules, clearly separated from real OS or dsh integration proof;
- **scorecard cases:** labels needed to calculate policy and regression metrics.

Every suite includes at least one labeled dangerous case and one safe expected-allowed case. A dangerous case cannot declare `allowed` as its expected result. Undefined metric denominators evaluate to `0`, not optimistic success.

The v0 runner invokes deterministic local validators only. `model_judge_results` is empty and no model is called. A later model or judge can add evidence to a new scorecard version, but cannot change a deterministic case result or authorize an action.

### Proposed trajectory-aware DSH evaluation

Text output alone is insufficient for a multi-step agent. A future scorecard version may accept a sanitized trajectory snapshot only when it records:

- the pinned DSH commit, profile/config digest, session-event format identity, session ID, selected event sequence range, and successful flush receipt;
- ordered `turn/start`/`turn/end`, `step/start`/`step/end`, model usage, `tool/call`/`tool/result`, approval asked/decided, cancellation, and terminal outcome facts;
- canonical tool and target identities without raw secrets, full command output, or unnecessary source content;
- independent filesystem/process/network side-effect receipts and pre/post artifact digests, because event replay does not reproduce or prove those effects;
- aggregate turns, steps, tool calls, repeated failures, elapsed time, token usage, and external requests/cost against explicit suite budgets;
- provenance for every deterministic assertion and any supplemental model, red-team, or observability result.

Trajectory assertions check more than final text: denied calls never reach execution evidence; every admitted call has one ordered final result; approval identity matches the call; path and sandbox claims match the independent receipt; no secret/PII enters the model-facing result or exported snapshot; repeated failures trigger the documented advisory or hard stop; and terminal state, side effects, and budget totals match the fixture. An unflushed or incomplete event range, unknown required event, missing side-effect receipt, or disagreement between the log and observed state is a hard stop rather than an optimistic score.

The **model-visible means logged** invariant governs every trajectory claim: anything the model could see must be reconstructable from the durable append-only event history. Compaction edits the current model projection, never the canonical record; sessions recover, fork, and rebuild approval state from the event log. Three things are kept distinct — (1) the canonical event history, (2) the current model projection, and (3) external business state. The enterprise question every digital-worker claim must answer: can every model-visible input be reconstructed from a durable event history, or does the system depend on mutable session summaries and implicit harness state? A trajectory that cannot answer this is not evaluation evidence; it is a lossy summary.

The DSH log remains canonical. A Promptfoo, PyRIT, Langfuse, Phoenix, or OpenTelemetry representation is a derived projection and may be incomplete or lossy.

| Optional adapter | Proposed role | Promotion constraint |
| --- | --- | --- |
| Promptfoo `0.122.1` | Primary future CI experiment: a pinned local TypeScript provider consumes a flushed trajectory and side-effect receipts; deterministic JavaScript/trace assertions feed an DAL scorecard | No native DSH provider is assumed. Disable sharing/remote inference, require zero external requests, and run inside the independently enforced test sandbox. Promptfoo results may block but never authorize. |
| PyRIT `v1.0.1` | Optional multi-turn red-team driver through a narrow DSH custom target | Isolated experiment only; attacker/scorer providers, data transfer, request/cost budgets, and target permissions require explicit review and approval. Not part of the default CI path. |
| Langfuse `v4.22.0` or Phoenix `v20.4.0` | Optional observability projection of sanitized sessions, turns, steps, tools, guardrails, and evaluations | Disabled/local by default. Preserve event sequence/digests, declare projection loss, and require exact approval for any external collector. Neither system becomes policy, provenance, replay, or approval authority. |

The existing DSH session-telemetry plugin exports OTLP logs, not this trajectory scorecard or a guaranteed Langfuse/Phoenix trace model. Uploading can include raw messages, tool arguments/results, prompts, file contents, and local paths unless a deployment supplies redaction rules. A future adapter therefore uses a dedicated minimal projection and keeps DSH telemetry disabled until privacy tests and external-transfer approval pass.

### Statistical evaluation of stochastic behavior

Status: Proposed and unimplemented. Version 0 runs deterministic local validators only and records no model output. Any future model-based or trajectory evaluation whose results are stochastic must satisfy these rules before its numbers may enter a scorecard.

- **Multiple seeds and rollouts per case.** Every stochastic case runs at least a declared minimum of independent rollouts across distinct, pinned seeds. A metric is never derived from a single run. The seed list is recorded in the scorecard and must match the executed rollouts.
- **Paired comparison, not pooled means.** A candidate is compared to its baseline on matched `(case, seed, fixture, prompt, harness)` pairs, so each rollout has a direct baseline counterpart. Two independent overall averages are never compared as if paired; any unpaired comparison is labeled as such and reported separately.
- **Separate pass@1, success rate, and variance.** `pass@1`, `pass@k`, mean success rate, and variance (standard deviation and confidence interval) are tracked as distinct fields. An improvement claim must cite the paired difference together with its spread; a mean without variance is not evidence.
- **Separate suites, no blended headline.** Capability, regression, safety, and adversarial cases stay in separate labeled suites. Metrics are computed per suite and are never collapsed into one aggregate number.
- **Full versioning of every dimension.** Model ID (weights/quantization), prompt/template digest, tool and provider versions, harness and sandbox config digest, and evaluation suite digest are recorded per run and bound to the scorecard. Any unversioned dimension invalidates a comparison.
- **No cherry-picking the best run.** Every run is retained and reported. A scorecard must include the full rollout distribution and the fixed seed list; re-running until a passing sample appears, or reporting only the best run, is prohibited. Declared-rollout count and seed-set completeness are verified, and a detected best-of-N selection is a hard stop.

Statistical decisions use confidence intervals rather than raw point deltas: a difference within the noise floor is "no change," not "better" or "worse." Hidden-case overfitting is reduced by holding out both cases and seeds and by extending the contamination review to include seed reuse.

### Model-versus-harness attribution

Status: Proposed and unimplemented. Version 0 runs no model, so attribution applies to future model-based evaluation. A self-improvement claim may not be promoted without it.

- **Factorial matrix.** Every improvement claim is evaluated on the full Model × Harness matrix: each cell is evaluated on the same suite, so a model gain (row difference with the harness fixed), a harness gain (column difference with the model fixed), and interaction effects are separately visible. Comparing a new model+harness pair against an old model+harness pair is confounded and is not an attribution.

  | | Harness A (baseline) | Harness B (candidate) |
  | --- | --- | --- |
  | Model 1 | eval | eval |
  | Model 2 | eval | eval |
  | Model 3 | eval | eval |

- **Pinned dimensions per cell.** Every cell records and holds fixed: tool versions, environment snapshot, task set, random seeds, inference parameters, context policy, and grader version. Cells that differ in any pinned dimension are reported as uncomparable, not as a difference.
- **Two-layer ablation.** A model-only benchmark (no agent scaffold) isolates raw model capability; an agent benchmark measures model+harness together. The layer difference is a harness effect and is reported as such, never folded into "the model improved."
- **External conflation evidence.** Independent benchmark monitoring reports double-digit harness-only swings for the same model on SWE-bench; the Self-Harness work improves pass rates by up to 40.6 points across nine model–benchmark pairs while keeping the model backend, tool set, budget, benchmark environment, and evaluator fixed. See the research note for pinned identities. Both are cited as motivation and prior art, not as dal dependencies.

### Self-improvement loop

Status: Partially implemented. Version 0 implements run-record ingestion, deterministic failure clustering, and the surface/prediction proposal boundary below; model-based tiers, sandbox evaluation of proposals, and the run/improvement plugin modes remain future work.

1. **Run tasks** — the agent operates normally; every workspace modification, tool call, and outcome is recorded.
2. **Collect traces and outcomes** — flushed, pinned trajectory snapshots plus independent side-effect receipts, as the trajectory section defines.
3. **Cluster failures** — tiered clustering below; the proposer never sees raw traces.
4. **Propose one falsifiable change** — a single bounded edit to one editable surface with a falsifiable predicted effect; GEPA or SkillOpt may propose behind the provider-neutral exchange schema.
5. **Predict improvements and regressions** — the proposal names expected metric deltas and expected regression risk, both of which the gate then checks.
6. **Evaluate in sandbox** — the deterministic gate, the Model × Harness matrix, and the stochastic discipline above all apply.
7. **Accept or reject** — only the evidence and a human decision promote a proposal; rejections are recorded and kept as negative evidence.
8. **Version and monitor** — accepted changes receive new digests and versions plus post-change monitoring; regressions trigger rollback.

The governing rule: **the agent may propose changes, but it should not control the evaluator, the holdout set, or its own permission boundary.** A self-declared improvement without trace-derived proposal evidence, an evaluation gate, and an accept/reject record is a claim, not an improvement. This matches the referenced improvement-loop cookbook and harness-engineering work: both start from traces and failure evidence, pass an evaluation gate, and then accept or roll back.

### Failure clustering without exploding context

The improvement-mode clustering pipeline keeps an LLM out of raw traces. Tier 0 and Tier 1 below are implemented in v0 (`dal cluster run`); Tiers 2 and 3 remain future work:

- **Tier 0 — canonical fingerprints at ingestion.** Every run record carries structured failure facts (category, code, and optional fingerprint extras) plus the pinned context. The clustering command computes a canonical failure signature at record time; raw trace text never enters any classifier context. *(Implemented.)*
- **Tier 1 — deterministic grouping.** Exact-signature clustering groups same-signature failures into immutable cluster records and skips successful runs, with zero tokens and no model. *(Implemented.)*
- **Tier 2 — local semantic tier.** The reserved local small model embeds compact per-step summaries; local centroid/online clustering groups near-duplicate failures with no external calls and no LLM context.
- **Tier 3 — budgeted LLM classifier.** An LLM sees only cluster representatives (fingerprint summaries, never full traces) to name clusters, merge near-duplicates, and propose root-cause hypotheses. Strict per-cluster and per-run token budgets are tracked and capped; classifier output is advisory labeling with recorded provenance, never authorization.

Cluster records are immutable, digest-pinned local files. The proposer consumes cluster digests and representative fingerprints, not raw traces. Privacy scanning runs before any embedding or classification, and human review gates cluster promotion into proposer input.

### Baseline metrics

| Metric | Definition |
| --- | --- |
| Task success | Cases whose observed effect and expected error code match, divided by all cases |
| Test pass rate | Passing harness cases divided by executed harness cases |
| Policy precision | Labeled dangerous cases correctly blocked divided by all blocked cases; `0` when no case is blocked |
| Policy recall | Dangerous cases correctly blocked divided by all labeled dangerous cases; `0` when the suite has none |
| Blocked-dangerous-action rate | Labeled dangerous action cases that do not receive `allowed`, divided by all dangerous action cases |
| Human override rate | Cases whose expected deterministic result was replaced by an asserted human override, divided by all cases; v0 baseline is `0` |
| Time/tool cost | Wall-clock milliseconds, deterministic validator calls, external request count, and external cost; v0 requires zero external requests and zero external cost |
| Post-change regression rate | Failed regression or golden cases divided by all regression and golden cases |

The repository baseline requires `1.0` task success, test pass rate, policy precision, policy recall, and blocked-dangerous-action rate; `0` human override and post-change regression rates; zero network/external cost; and suite-specific time/tool budgets within policy maxima. These strict values apply to the deterministic v0 fixture suite, not to unmeasured production claims.

### Scorecard authority

Every scorecard states evaluator kind, immutable suite and policy snapshots with digests, fixture-set and target digests, case results, metrics, thresholds, budget use, contamination review, human review state, and hard-stop reasons. Current-context validation reloads the suite and policy, verifies fixture URI/path/digest identity, replays every deterministic case, and derives metrics, thresholds, and hard-stop state rather than trusting their stored values. A passing scorecard is necessary evidence for an improvement proposal; it is never application authority.

At evaluated proposal stages, `dal` additionally verifies the scorecard file digest, hashes the current candidate artifact, and requires its proposal ID, candidate URI/digest, result, named metric, and candidate score to match the proposal. Self-reported passing fields or forged observed effects cannot substitute for deterministic replay.

| Evidence type | May block? | May authorize shared or irreversible action? |
| --- | --- | --- |
| Deterministic schema/privacy/policy/test result | Yes; fail closed | No; it can establish prerequisites only |
| Model or LLM-as-judge result | May recommend quarantine or human review | Never |
| Human review of a scorecard or proposal | May approve/reject the review stage | Not by itself |
| Separate exact sensitive-action approval | Required at execution boundary | Yes, only for its action/scope/digest and only where an executor exists |

## Hard stops

Any condition below sets the scorecard result to `hard_stop`, prevents proposal advancement/application, and requires quarantine or rollback review:

1. A secret or likely PII survives outside declared redaction metadata.
2. Any labeled dangerous action receives `allowed`, or policy precision, recall, or blocked-dangerous-action rate falls below threshold.
3. A schema, policy-violation, golden, regression, or immutable-provenance case fails.
4. An approval is absent, rejected, expired, wrong-action, wrong-scope, wrong-candidate, or not yet effective.
5. A request exceeds call, time, byte, rate, network, or external-cost policy.
6. A capsule is stale, missing, sensitive, or source-drifted.
7. A plugin, skill, capsule, proposal, fixture, policy, or base artifact digest differs from reviewed evidence.
8. Evaluation contamination is detected or its required human review remains unknown.
9. A model/judge is the only positive evidence for a shared, destructive, external, or irreversible action.
10. Required sandbox/integration evidence is absent while the claim depends on that boundary.

## Quarantine, rollback, and release

Quarantine is fail-closed: a hard-stop scorecard records the artifact identity, and its exact target digest remains unusable when policy reads the configured evaluation store. Historical quarantine validation uses the scorecard's embedded suite/policy snapshots so later ordinary target or policy changes do not invalidate the entire store; malformed or internally inconsistent evidence still fails closed. Immutable decision and scorecard records are not deleted or rewritten.

| Artifact | Quarantine trigger and stop | Rollback path | Release requirement |
| --- | --- | --- | --- |
| Cordis/dsh plugin | Unknown digest, missing supply-chain evidence, unsafe capability, install attempt, or failed policy/regression case; keep it unmounted | A human uses the separately approved dsh procedure to restore the last known-good pinned plugin/profile; v0 performs no change | New digest, clean deterministic and sandbox scorecard, provenance review, and separate install/mount approval |
| Project skill | Prompt-injection behavior, unsafe tool request, privacy leak, or golden regression; stop loading the quarantined digest | Restore the reviewed repository version through normal version control and rerun the suite | Human review of the diff and passing scorecard; shared installation still needs approval |
| Knowledge capsule | Stale date, missing source, digest drift, injection-shaped unsafe instruction, or sensitive data; `capsule check` fails before use | Use the last committed source-bound capsule or review sources and publish a new version; never silently refresh | Human source review, new digest/version, passing capsule/adversarial checks |
| Optimizer proposal | Hard-stop scorecard, contamination, reward-hacking signal, regression, budget breach, or approval mismatch; no transition to application | Leave the target artifact unchanged; retain the rejected proposal and evaluation evidence | New proposal/candidate digest, uncontaminated passing scorecard, human proposal decision, then separate unexpired application approval in a future executor |

Automated checks may quarantine. A failed post-change regression threshold selects `rollback`; other hard stops select `quarantine`. Only a human may declare rollback complete. Version 0 has no same-digest release: remediation creates a new artifact digest and passing reviewed evidence while the triggering digest remains quarantined. Human review cannot erase the triggering evidence or make v0 execute a disabled action.

## Acceptance criteria

1. A safe local read or verifier request validates, evaluates to `allowed`, and produces an immutable decision record without execution.
2. A feedback or guardrail fixture containing a likely secret or PII fails before any record is written and names only the rule, never the matched value.
3. An unapproved optimization-candidate application request does not receive `allowed`, records the missing-approval rule, and leaves the target unchanged.
4. Offline suites include every required fixture class and calculate every baseline metric deterministically.
5. Any hard-stop case produces a failed scorecard with quarantine/rollback disposition and cannot advance an improvement proposal.
6. Model/judge evidence cannot satisfy human-only transitions or sensitive-action approval in schema, policy, CLI, or tests.
7. No evaluation or policy command contacts a service, invokes an LLM, executes a requested tool, installs a plugin, changes dsh configuration, or applies a candidate.
