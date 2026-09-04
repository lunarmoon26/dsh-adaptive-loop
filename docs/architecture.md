# DSH Adaptive Loop Architecture

Status: Implemented v0; evidence tracked in [`requirement-evidence.md`](requirement-evidence.md)
Audience: developers, reviewers, dsh plugin authors, and optimizer-adapter authors
Last contract review: 2026-09-04; pinned upstream evidence remains in [`research-evidence.md`](research-evidence.md)

## Purpose and scope

`dal` is a local control plane around software-development tasks. It captures bounded task evidence, makes patterns queryable, and stages improvements for human decisions. Its zero-configuration dsh integration remains repository instructions plus a project-local skill. Optional Cordis packages add run recording and an isolated HMR candidate workbench, but source presence never mounts a plugin or changes a dsh profile.

## Quality scenarios and constraints

| Priority | Context and stimulus | Observable response | Measure |
| --- | --- | --- | --- |
| 1 | A feedback record contains a likely credential | Persistence fails closed | No record file is created; the secret rule is named |
| 2 | A proposal reaches a sensitive action | The action lacks exact human authorization | Verification rejects wrong action, scope, status, or expiry |
| 3 | A capsule's source changes or ages out | A small model requests the capsule | Validation fails before the capsule is treated as current |
| 4 | Two producers use one feedback ID | Their content differs | The first record remains unchanged and the conflict fails |
| 5 | A task is blocked or aborted | Completion evidence is incomplete | An explicit exception record remains valid and queryable |
| 6 | Untrusted content requests shell, file, network, plugin, or optimizer capability | The request reaches the deterministic boundary | Unsafe capability is denied and immutably audited without execution |
| 7 | A candidate improves one score but fails privacy, policy, budget, or golden behavior | The evaluation suite finishes | The scorecard hard-stops and quarantines the candidate digest |
| 8 | A benchmark candidate attempts to inspect goals, grader code, or effect logs | The e2e attempt starts | Candidate receives only a minimal read-only workspace and typed service access; oracle data stays on the grader network |
| 9 | A controller estimate receives mixed generations, contexts, or inadequate denominators | The estimate is requested | Mixed evidence fails closed; inadequate evidence publishes a non-authorizing `insufficient_evidence` state |
| 10 | A run lacks authoritative generation evidence or spans a Loader/HMR transition | Controller enrollment is requested | Repository evidence and its JCS manifest are verified; missing, unstable, downgraded, or mismatched evidence fails closed |
| 11 | An approved staged plugin candidate changes watched source | DSH HMR succeeds, fails, or another plugin reloads | Only a matching success admits; failed admission restores source; checkpoints and sessions spanning any success are evaluation-ineligible |

Hard constraints:

- Local-only is the default. There is no generic network/shared-config executor, optimizer runtime, or plugin installer/mounter. The sole candidate applier is fixed to configured files in an isolated linked worktree and independently verifies exact approval at its operation.
- HMR approval verification executes only a startup-digested DAL CLI launcher chain outside the candidate worktree; workspace package scripts and changed launcher files fail closed.
- Exact data syntax lives in JSON Schema, not duplicated prose or TypeScript literals.
- Every persistent mutation is local, explicit, and atomic at one-record granularity.
- dsh integrations respect Cordis lifecycle ownership: registrations use plugin effects, HMR owns module replacement, and durable facts use session events.
- Deterministic guardrails run before evaluators; model/judge evidence never grants capabilities or approval.
- Future evaluation or observability adapters consume sanitized projections only; the DSH session log and DAL immutable records remain authoritative.

## Context and interfaces

| Actor or system | Inputs | Outputs | Trust boundary and owner |
| --- | --- | --- | --- |
| Developer or dsh agent | Task facts and evidence references | Feedback JSON | Producer must summarize and redact; feedback contract owns fields |
| `dal` CLI | JSON records, filters, capsule paths, decisions | Local records, deterministic reports, and explicitly approved proposer/install operations | Local by default; purpose-specific sensitive paths verify exact approvals at execution |
| Local team store | Validated ingestion envelopes | Queryable JSON | Filesystem permissions and immutable-ID checks |
| dsh | `AGENTS.md`, project skill, and optional plugin/HMR events | Task execution, module activation, and session facts | dsh owns session and HMR lifecycles; DAL plugin source is not mounted or profile-authoritative by default |
| Human reviewer | Review and decision identity | Scoped approval or rejection | Only authority for sensitive actions |
| Deterministic optimizer adapter | Sanitized exchange JSON and bounded-edits candidate | Training set and validation verdict | Prepare/evaluate only; no optimizer execution or application authority |
| GEPA or SkillOpt runtime | Future adapter data | Future candidate | Not installed or executed; external transfer requires approval |
| Guardrail evaluator | Structured, non-executing capability request | Immutable allow/deny/approval-required decision | Local deterministic policy; no requested tool execution |
| Evaluation harness | Pinned local fixture suite and target digest | Immutable scorecard and hard-stop disposition | Deterministic v0 runner; no model/provider/network |
| Controller estimator | Controller policy plus one run-record batch | Immutable state with context/generation identities and proportion intervals | Observation only; no proposal, budget, model, execution, or promotion authority |
| Runtime generation producer | Effective Loader tree/config, resolver results, artifacts, and mutation lifecycle | Immutable manifest/evidence plus synchronous session binding | DSH launcher-owned and not implemented here; DAL validates and consumes the contract only |
| Tau workflow service and grader | Seed state, effect requests, full evaluator task | Checksummed journal, authenticated snapshot, deterministic verdict | Separate containers/networks; candidate has typed service access but no journal, token, grader, or full task |
| Optional dsh plugin set | Fixed candidate paths, protected tool calls, live agent control, HMR, and durable session events | Privacy-safe run records, staged candidate admission/rollback, workbench tools, and a disabled G2 retry guard | Source and focused tests ship; mount and each application require separate authority; DSH owns execution, HMR, and session lifecycle |
| Future evaluation/observability adapter | Flushed sanitized trajectory plus independent side-effect receipts | Promptfoo input or OpenTelemetry/OpenInference projection | Optional; no authority; external transfer requires exact approval |

## Solution strategy

- Reuse dsh's project instruction chain and `.agents/skills` discovery for the zero-shared-config default; keep user-global installation separately approval-bound.
- Reuse dsh's success-only HMR reload event for bounded plugin candidates; do not add a second module loader or patch DSH core.
- Keep structured feedback outside dsh's free-text `feedback/record` event because v0 needs validation, team aggregation, provenance, and secret rejection.
- Store immutable per-record envelopes rather than a mutable database. Query scans the bounded local directory; a database index can be added only when measured scale requires it.
- Treat improvements as staged state transitions. Evaluation evidence and application authority are separate records.
- Treat optimizer providers as adapters over versioned JSON, not as owners of policy or persistence.
- Keep task-class controller state separate from the candidate-scoped proposal lifecycle; controller output is evidence or recommendation, never authorization.
- Keep runtime-generation identity separate from appraisal: JCS manifest bytes identify composition; evidence records assurance and per-session transition stability.
- Pin capsule claims to source identity, digest, and refresh time.
- Put deterministic schema, privacy, capability, sandbox-declaration, budget, provenance, and approval checks ahead of score-based evaluation.
- Treat hard-stop scorecards as quarantine evidence, never as mutation instructions.
- Attach future DSH enforcement to the narrow owning waterfall or capability operation instead of inserting a control-flow gateway around the agent loop.
- Evaluate agent behavior from ordered Turn/Step/tool/approval events plus independently observed side effects; text output alone is insufficient.

Current significant decisions: [`decisions/0003-purpose-specific-approved-executors.md`](decisions/0003-purpose-specific-approved-executors.md) preserves the local staged core while allowing only named operation-owned executors; [`decisions/0004-separate-run-to-run-supervisor.md`](decisions/0004-separate-run-to-run-supervisor.md) separates task-class controller observations from candidate proposal state; [`decisions/0005-separate-runtime-generation-identity-from-evidence.md`](decisions/0005-separate-runtime-generation-identity-from-evidence.md) separates canonical runtime identity from assurance and session-transition appraisal; [`decisions/0006-stage-approved-candidates-through-hmr.md`](decisions/0006-stage-approved-candidates-through-hmr.md) uses inactive staging plus existing DSH HMR for plugin evaluation without granting promotion authority.

## Level-one building blocks

| Building block | Responsibility | Owned state | Interface |
| --- | --- | --- | --- |
| Project workflow | Route feature tasks through feedback completion | Instructions only | `AGENTS.md`, `end-task-feedback` skill |
| Contract validator | JSON Schema plus cross-field invariants | None | validation API and CLI |
| Privacy scanner | Detect likely secrets before persistence | Rule-set version | scan API |
| Feedback store | Atomic immutable ingestion and local queries | Stored-record files | ingest/query/summary API |
| Improvement model | Validate ordered transitions and human checkpoints | Proposal JSON | transition API and CLI |
| Approval guard | Verify action, scope, decision, and expiry | Decision JSON | verification API and CLI |
| Capsule validator | Detect syntax, freshness, and source drift | Capsule JSON | check API and CLI |
| Optimizer boundary | Define provider-neutral request/candidate/result data | Exchange JSON only | disabled adapter protocol |
| Guardrail policy | Evaluate explicit tool/capability intent without execution | Immutable decision files | policy API and `policy check` CLI |
| Evaluation harness | Run offline/adversarial/golden/policy fixtures and calculate scorecards | Immutable scorecard files | evaluation API and `eval run` CLI |
| Controller observation | Validate one controller policy, reject mixed evidence, estimate configured proportions and uncertainty | Immutable controller-state files | internal control API and `control estimate` CLI |
| HMR candidate coordinator | Stage fixed plugin files, verify exact application, observe DSH HMR, expose active generation, restore baseline | In-memory baseline and generation; inactive `.dal/hmr-candidate/` copies | `dal_candidate_*` tools and `ctx.dalCandidate` |

## Critical flows

### End-of-task feedback

1. The agent records task facts in a feedback fixture-shaped JSON document.
2. Schema validation checks exact fields; semantic validation checks outcome and review invariants.
3. The privacy scanner walks structured string values and rejects likely credentials and PII before persistence.
4. Ingestion computes source and feedback SHA-256 digests and atomically publishes one immutable stored record.
5. The agent runs a focused query or summary and links the record in its task result.
6. Blocked and aborted tasks follow the same flow with a required exception object instead of claiming completion.

### Improvement proposal

1. Queries produce observations; a normalizer records bounded findings and source record IDs.
2. A human reviews the normalized findings before a proposal is recorded.
3. A future adapter evaluates a frozen candidate in a sandbox and returns evidence; v0 only validates a pre-existing receipt.
4. A human approves or rejects the evaluated proposal.
5. Application requires a separate approval decision scoped to the exact proposal.
6. Post-application measurements append evidence and close the lifecycle at `measured`.

### Capsule use

1. The caller validates the capsule before loading its claims.
2. Validation checks schema, freshness, and local source digests.
3. The model reads compact claims, then follows only the retrieval pointers needed for the task.
4. Any source change requires explicit capsule review and digest update; there is no automatic refresh.

### Isolated plugin candidate

1. A separately approved workbench profile mounts the coordinator outside its configured editable entry directory in a linked worktree.
2. The coordinator copies the clean live files to inactive staging; the agent edits only those copies.
3. A human decision binds the staged digest. The coordinator re-verifies it through startup-pinned external launcher files, writes dependencies then the entry, and accepts only a matching successful DSH HMR event; any other successful reload aborts admission and starts rollback.
4. `dal-run-record` binds the active candidate generation at `session/created`; a later successful HMR event makes that run ineligible.
5. Rejection restores and reactivates the in-memory baseline. Acceptance still requires human git review and commit.

### Guardrail and evaluation flow

1. A producer creates a bounded action request containing semantic operation identity, input trust, target digest, sandbox declaration, and budget; raw arguments and source content are excluded.
2. Schema and secret/PII checks run before persistence.
3. Deterministic policy evaluates capability, canonical repository URI containment, network, sandbox, budget, quarantine, and exact approval prerequisites. Traversal-shaped and encoded repository paths fail closed. It records one immutable decision per action ID, binds supplied approval content by digest, rejects stale retries when dynamic prerequisites change, and executes nothing.
4. The offline harness verifies fixture digests and contamination review, runs deterministic cases, and calculates the canonical scorecard metrics.
5. Any privacy leak, dangerous allow, policy/golden failure, contamination, drift, or budget breach emits a hard-stop scorecard. Post-change regression selects manual rollback; other failures quarantine the exact target digest.
6. Evaluated proposal stages reload the referenced scorecard, verify embedded suite/policy snapshots and current source identities, replay deterministic fixtures, derive metrics/thresholds/hard-stop state, and hash the candidate artifact itself. A passing scorecard can support later human review but cannot authorize or apply any artifact.

### Tau-style benchmark attempt

1. Before any model call, the driver hashes a transmission manifest containing model routing, generation, rollout count, fault/resolution profile, executed image/tools identities, projected and evaluator task digests, driver-source digests, policy, skill, prompts, and exact stable composition-patch text, then verifies an exact `send_data_externally` decision.
2. It atomically seeds a checksummed append-only journal, stages only agent-visible inputs in a read-only candidate workspace, stages the full task separately for the grader, and rehashes the manifest immediately before each model call.
3. The service starts by the approved immutable image digest on the candidate network as the sole journal writer, then joins a separate internal grader network. The evaluator token is present only in service/grader environments.
4. The candidate runs with no repository or oracle mount and reaches state only through typed workflow tools. The grader mounts the full task only after the candidate exits and retrieves the authenticated state/effect snapshot.
5. The driver immutably stores the approved manifest and records its digest in each receipt and summary alongside separate harness/business outcomes plus state, effect-journal, staged-workspace, image, session, composition, isolation, and verdict digests. Receipt verification binds task, candidate, model, generation, image, manifest, and real run ID back to the summary; the persisted run record is independently path/digest-bound, and duplicate evidence or counters inconsistent with receipt outcomes fail closed. Comparison rejects context drift and candidate/model confounding. It removes the attempt containers and both networks on every exit path.

### Run-to-run controller observation

1. A human-authored controller policy fixes the logical task class, exact run task set, runtime-generation digest profile/minimum assurance, estimator identity, metric sources, targets, deadbands, and sample minima.
2. The estimator validates every run-store record, then selects the requested task set and batch.
3. It rejects unattested, unstable, or under-qualified sessions, loads each canonical repository-local evidence document and referenced manifest, recomputes the RFC 8785 digest, then normalizes and compares context and generation identities. Seeds remain observations; mixed, unpinned, unavailable, or mismatched evidence fails closed.
4. It computes harness, business, or named-check proportions with explicit exclusions and 95% Wilson intervals.
5. It derives estimate time from policy/run evidence, binds the state ID to the complete canonical snapshot, and publishes the snapshot exclusively. A ready or insufficient state changes no proposal, budget, harness, or runtime.

## Data and privacy

- The producer feedback is retained byte-for-byte as parsed JSON inside an ingestion envelope; ingestion does not silently redact or rewrite evidence.
- The scanner rejects unsafe input. A producer may replace sensitive text with an explicit `[REDACTED:<reason>]` marker and records that redaction in the privacy section.
- Evidence records contain references and safe summaries, not payloads. Tool calls contain name, purpose, status, timing, and evidence IDs, not arguments or outputs.
- Likely PII is treated like likely secrets: reject before persistence unless the unsafe source text has already been replaced by declared typed redaction markers.
- Stored records are immutable by feedback ID. Corrections use a new feedback ID and a `supersedes` provenance reference.
- Deletion and retention are manual v0 operations governed by [`governance.md`](governance.md); the CLI has no delete command.

## dsh and Cordis integration

Current integration uses dsh behavior that already exists:

- dsh loads project `AGENTS.md` through its agent-instructions plugin.
- dsh discovers `<project>/.agents/skills/<name>/SKILL.md` without a shared profile edit.
- dsh HMR transactionally replaces loaded plugins and emits `hmr/reload` only after successful activation; DAL consumes that event without owning replacement.
- dsh's workflow/session packages provide useful future event and cancellation vocabulary, but their observe-only events cannot guarantee a final structured write on hard process loss.
- DAL's recorder can consume a launcher-owned `runtimeGeneration` service at `session/created`; current DSH does not yet produce the authoritative config/resolver/artifact evidence required for that service.

### Deployment model

`dal` defaults to a repository-scoped control plane. The repository also owns optional Cordis plugin packages, but no package is mounted merely because its source exists. Starting dsh in a new workspace yields no dal skill, instructions, CLI, store, or plugin composition unless an approved deployment tier installed them. Three deployment tiers:

| Tier | Shape | New-workspace behavior | Gate |
| --- | --- | --- | --- |
| 1. Repo-scoped (current) | `dal init` scaffolds stores, skill, and instructions into each workspace | Loop present per initialized workspace | None |
| 2. User-global install | `dal install user-global --approval <decision>` writes the skill under `~/.agents/skills/` and the fixed user-global `~/.dsh/AGENTS.md`; CLI on PATH | The workflow and skill are discovered in every workspace | An exact approved, unexpired `change_shared_harness_config` decision verified at the operation; differing existing content fails closed instead of overwriting |
| 3. Cordis plugin (source shipped; deployment approval-gated) | Opt-in dsh plugin bundle with run, improvement, HMR-candidate, and disabled G2 rows, loaded by profile composition | Mounted modes become part of that explicit dsh profile; the HMR row accepts only fixed linked-worktree paths | Install/mount approval; each HMR/G2 application additionally needs exact candidate approval plus promotion gates |

Verified discovery roots at the pinned checkout: `packages/skill/skill-filesystem/src/index.ts:241-260` (project `.dsh/skills` and `.agents/skills`, then user `~/.dsh/skills` and `~/.agents/skills`) and `packages/context/agent-instructions/src/config.ts:19` (fixed user-global `AGENTS.md` in the harness home). The instruction loader reads files only — no programmatic instruction registry exists in the inspected version, so a plugin cannot register "rules" into the instruction baseline; plugin-side `agent.inject()`/`agent.steer()` is advisory and separate. The global `AGENTS.md` file is therefore the automated seam, written only by the approval-verified install command.

The evidence store stays repository-local in every tier; a user-level store for non-repository work and cross-workspace aggregation remain open future decisions.

### Usage model: run and reconcile

The intended operation is a batch, human-gated loop, not continuous autonomous self-improvement:

- **Run phase.** Agents operate normally in a workspace that contains the team's code or workflow files, project `.agents/skills`, and optional project `.dsh/` plugins/tools. The shipped mode bundle keeps run recording enabled and improvement tools disabled, but neither mode runs unless separately mounted into a profile. Without that deployment, each task ends with the agent writing its structured feedback and, for failure evidence, a run record; the optional run-record plugin provides privacy-safe lifecycle capture after approved mounting.
- **Team sharing via VCS.** The evidence stores `.dal/outbox`, `.dal/store`, `.dal/runs`, and `.dal/clusters` are tracked in version control so everyone working in the workspace logs into the same history. Records are immutable per ID, so parallel writers only collide on duplicated IDs (a designed failure). Check, demo, and test artifacts under `.dal/` remain ignored.
- **Reconcile phase.** One human — a team lead or maintainer — runs `dal feedback summary` and `dal cluster run` over the accumulated records, reviews the clusters, drives proposals through the staged lifecycle (including the falsifiable prediction), and evaluates in the sandbox or isolated HMR path. HMR admission is temporary evaluation state; only the human commit promotes the skill/tool/harness change, and the proposal's `applied -> measured` transition records it.

This split keeps agents cheap and uninterrupted during the day and concentrates evaluation, governance, and application authority in a single human-reviewed batch.

**Two improvement lanes.** Evaluator, oracle, and simulator semantics are measurement infrastructure, not agent behavior. Changes to them are *benchmark maintenance*: they bump the benchmark version, rebaseline every generation, and never count as agent improvement. Changes to prompts, skills, tool descriptions, routing, and harness plugins are *agent evolution*: they must land on the frozen benchmark and be measured against the previous generation. The tau-style e2e experiment enforces this split: its G0/G1 comparison requires the same model and frozen benchmark-context digest while candidate and generation digests differ; same-generation provider comparisons require the candidate digest to remain fixed. The source-only G2 guard is a separate disabled harness-code candidate, not part of either G0/G1 measurement.

The Cordis integration remains an opt-in plugin set rather than one privileged gateway. Shipped rows use `inject`, services, and `ctx.on()`, preserve model-visible/logged invariants, and remain independently removable. Broader policy/output/budget integrations remain future work. Installing or mounting any row requires human approval.

Cordis is not plain dependency injection; it is a dynamic capability graph. `Context` answers which capabilities exist now, `Service` names what a module provides, `Plugin` owns the resources and their lifecycle, and `Inject` decides whether dependent capabilities deactivate when a dependency disappears. The engineering object has changed from "agent has tools" to "the runtime exposes a changing capability graph; a session binds to a scoped projection of that graph; plugins own capability lifecycles; dependencies determine activation." DAL's guardrail and capture plugins must be designed as graph members, not as a control-flow gateway.

DSH's composition graph is itself the self-improvement surface: stable component IDs, bundles as ordered patch layers, profiles composing bundles, presets defining capability levels, user overlays in the same patch language, service-driven activation, generation-based configuration, and sessions retaining their generation. A proposal therefore prefers structured composition patches over free-form harness edits — addressed by stable ID, with explicit diff, composition provenance, lifecycle boundaries, and a reconstructable effective configuration, evaluated as a new generation before promote/reject/rollback/retain-as-branch. DSH ships the substrate, not the RSI system: independent evaluator, sealed holdout, reversible promotion, regression gates, conflict resolution, and evaluator immutability are exactly what dal must add.

Profiles are user-global (`$DSH_HOME/profiles/<name>`; project-level `.dsh` profiles are unsupported at the pinned identity). The adopted pattern keeps the workspace as the single source of truth: plugin packages live in the workspace VCS next to skills and prompts, digest-pinned; installing them from those local paths into the root-level profile produces a derived installation generation. The install is a sensitive action with exact approval, and rollback is reinstalling the previous pinned generation. Everything the loop edits stays workspace-owned and VCS-recoverable; the profile is a reproducible deployment, not a source.

### Optional dsh guardrail plugin set

This topology is partially source-implemented. The run recorder, deterministic workbench tools, and fixed-path HMR candidate coordinator ship as package source; the unknown-effect retry row remains a disabled, unit-tested candidate. None has been installed or mounted into a shared profile, and no repository candidate has been applied. Focused event-contract tests and a pinned local DSH Loader/HMR composition probe exercise HMR admission, rollback, and session attribution; they do not prove a production mount. The remaining policy, output-filtering, budget, approval, and export rows are design-only.

| Responsibility | Verified DSH extension point | Required behavior and limit |
| --- | --- | --- |
| Tool policy, command inspection, and early path checks | `tools/pre-execute` waterfall | Inspect protected tool identity and arguments; return allow, deny, or ask without rewriting arguments. Shell, filesystem, and sandbox providers recheck at the operation that executes or mutates because a generic hook is not confinement. |
| Cooperative per-call deadline and execution metrics | `tools/execute` waterfall | Wrap dispatch and preserve cancellation semantics. Listener order is explicit; a signal is not a hard kill when a provider ignores it. |
| Secret/PII filtering and bounded model-facing output | `tools/post-execute` waterfall | Block or replace content/value before final `tool/result`; emit only rule IDs, truncation counts, and safe provenance. This cannot undo tool side effects or sanitize earlier user/tool arguments already in the session. |
| Final outcome observation | `tools/result` emit and durable `tool/result` session event | Observe the frozen result for counters and diagnostics; never treat `tools/result` as a fourth waterfall or enforcement point. |
| Repeated-failure and aggregate budget state | `session/event` plus `agent/pre-step` or `tools/pre-execute` | Reconstruct bounded per-agent state from durable events. Observers cannot veto committed events; enforce the next operation through a decision waterfall or cooperative cancellation. Advisory steering/injection remains logged and cannot replace a hard stop. |
| Unknown-effect retry guard (disabled G2 candidate) | `tools/pre-execute` plus `tools/result` | Claim same-key effect calls before dispatch, retain the per-agent lock on `unknown`, and release only after a terminal `get_effect_status` result. Source/tests are not deployment authority; mount and application each require exact approval. |
| Permission escalation | `approval/request` waterfall | Supply one terminal, one-shot answerer and retain paired audit facts. A DSH grant does not satisfy DAL sensitive-action approval unless an adapter separately verifies exact action, scope, target digest, decision, and expiry. Headless absence fails closed. |
| Runtime-generation binding | `session/created` plus a launcher-owned generation service and Loader/HMR transition counter | Bind before the first event, return no binding during mutation, and never decrement the transition counter on failure/rollback. Current DAL consumes and tests the structural contract; DSH production remains upstream work. |
| Trajectory capture and export | Canonical session log, `session/event`, and explicit session flush | Pin DSH commit/profile/config, sequence range, event-format identity, and flush receipt. Treat Turn/Step/tool/approval events as recorded trajectory, not proof that external side effects are replayable. |

The event-to-evaluation path first flushes the session, then projects the selected event range into a privacy-safe trajectory and joins independent workspace/process side-effect receipts. The local deterministic evaluator remains the first authority. A future pinned Promptfoo custom provider may consume that snapshot for CI assertions; optional PyRIT attacks and Langfuse/Phoenix projections remain separate adapters. No adapter can mutate policy, approvals, the canonical log, or scorecards.

DSH already has an optional session-telemetry seam and an OTLP/HTTP log backend, disabled by default. Uploading modes can include complete message, tool, prompt, filesystem, and working-directory data unless a deployment mounts redaction rules. DAL integrations therefore require telemetry to remain disabled unless a separately reviewed sanitizer and exact external-transfer approval are active. OTLP logs are not assumed to be losslessly compatible with Langfuse or Phoenix trace/span models.

## Self-improvement loop

Status: Partially implemented in v0: run-record ingestion, deterministic harness/business failure clustering, run-to-run observation state, the surface/prediction proposal boundary, branch selection/evaluation, an approval-bound proposer branch, and unmounted run/improvement plugin source ship today. PI governance, model-based clustering, response learning, predictive selection, optimizer execution, sandbox candidate application, canary, rollback control, and deeper search remain design-only. The boundary is explicit: **the agent may propose changes, but it should not control the evaluator, the holdout set, its maximum budget, promotion policy, or its own permission boundary.**

### Editable surface

The proposer may edit only these surfaces, one bounded change per proposal, every item versioned and digest-pinned:

| Surface | Example change | Required evidence |
| --- | --- | --- |
| Prompt | Instruction or template text | Failure-cluster evidence plus a falsifiable predicted effect |
| Tool descriptions | Capability and parameter wording | Same |
| Skills | Bounded append/insert/replace edits | Same |
| Memory policy | What enters or leaves project memory | Same |
| Routing | Model/step selection rules | Same |
| Stop/retry logic | Loop detection and retry thresholds | Same |
| Harness code | Scaffold or plugin code | Same |

Weights are reserved for a later stage, and the reserved slot is a local knowledge-base small model (an embedding/clustering tier for trace analysis), never silent fine-tuning of the main model. v0's proposer/e2e may call a configured model only after exact external-transfer approval; no model or optimizer runtime is embedded in the deterministic loop.

### Immutable anchor

The proposer can never edit these; only humans change them through the review and approval process:

- Evaluator
- Sealed holdout set
- Permissions
- Maximum budget
- Promotion policy
- Audit log
- Rollback mechanism

### Run mode and improvement mode

The shipped, unmounted plugin bundle has two operational modes and one separately disabled G2 candidate row:

- **Run mode** — the recorder row is enabled in the bundle and projects session events into privacy-safe durable evidence. No improvement code runs in the hot path.
- **Improvement mode** — deterministic workbench tools ship disabled and can read the immutable store, cluster failures, prepare proposer payloads, summarize evidence, inspect reset status, and evaluate branches. They expose no model call, candidate application, or anchor mutation.
- **G2 candidate** — the unknown-effect retry guard row ships disabled. Mounting and applying it are separate exact approval operations.

### Proposer search seam

Optimizing workspace skills and the profile plugin runtime over logged sessions is a search/path-dependency problem, not a one-shot edit — closer to playing Go than to writing a patch once. The seam keeps the optimizer boundary unchanged: proposals become branches in a bounded search tree; deterministic evaluation is the value function; human promotion is the selection policy; rejected branches are retained as negative evidence; and alternative branches may be kept instead of discarded (the Darwin Gödel Machine archive pattern). v0 ships branch record/select/evaluate plus one approval-bound model expansion; deeper MCTS-style select/expand/evaluate/backup, optimizer-driven expansion, and automatic rollout remain future work. Search depth, width, and evaluation count remain policy-bounded.

## Risks and technical debt

| Risk or debt | Impact | Current mitigation | Next decision trigger |
| --- | --- | --- | --- |
| Instruction compliance cannot guarantee final logs | Missing records | Completion workflow and explicit validation receipt | Need lifecycle-level enforcement in real dsh sessions |
| Pattern scanning has false negatives and positives | Secret exposure or blocked safe text | Reject before write, explicit rule receipt, manual data policy | Add audited scanner or organization policy |
| Directory scan queries are linear | Slow queries at high volume | Small local v0, deterministic files | Measured query latency or concurrent team store |
| Filesystem permissions are not encryption | Local disclosure | Restricted content policy and local-only default | Regulated or multi-tenant use |
| dsh, GEPA, and SkillOpt are pre-stable | Adapter drift | Pinned evidence and capsule freshness | Version update or first provider implementation |
| Sandbox evidence is provider-specific | False safety assumptions | Claims name the exact executed verifier backend or Docker topology; no optimizer or candidate application inherits that proof | First optimizer rollout or candidate sandbox evaluation |
| DSH sandbox enforcement differs by platform and mode | A nominal permission level is mistaken for uniform filesystem, process, or network isolation | Pin runner/enforcement completeness; independently deny network; never treat `danger-full-access` as sandboxed | First DSH execution adapter |
| Prompt-injection detection is incomplete | Model follows malicious repository text | Capabilities derive only from deterministic structured policy, plus adversarial fixtures | First real dsh lifecycle guard |
| Candidate provider egress is not destination-allowlisted | A compromised candidate process can misuse the selected provider credential while its network is open for the model API | Pass only the selected key, use an attempt-scoped container, expose no oracle token/repository, and document that topology proof is not credential-confinement proof | Design and approve a provider allowlisting proxy before claiming credential egress confinement |
| Fixed fixtures can be contaminated or gamed | Inflated score and unsafe proposal | Digests, split labels, contamination review, hidden-case rotation, human review | First optimizer experiment |
| Plugin provenance is digest-only in v0 | Signed or dependency compromise is missed | No plugin installation; quarantine and separate approval | First approved plugin installer design |
| Event observers run after commit | A detector notices a loop after the current effect has occurred | Enforce at the next `agent/pre-step` or tool decision; use cancellation only as cooperative containment | First repeated-failure hard-stop plugin |
| Trajectory or observability export contains sensitive session data | External disclosure | Default disabled; minimize and scan projections; require exact transfer approval | First Promptfoo, Langfuse, Phoenix, or remote collector adapter |
| A point estimate is mistaken for adaptation authority | Noisy batches trigger unsupported changes | Controller state records intervals, exclusions, sample sufficiency, and an observation-only boundary | First PI governor or automatic mode-entry experiment |

## Glossary

| Term | Meaning |
| --- | --- |
| Apply | Change a prompt, skill, Cordis plugin, or harness configuration using an approved candidate |
| Candidate | Frozen proposed text or bounded edit set plus base identity |
| Capsule | Compact source-bound context for model retrieval |
| Sensitive action | Shared config change, plugin install, external transfer, or candidate application |
| Store | Local directory of immutable stored-record JSON files |
