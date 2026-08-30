# DSH Adaptive Loop Architecture

Status: Implemented v0; evidence tracked in [`requirement-evidence.md`](requirement-evidence.md)
Audience: developers, reviewers, dsh plugin authors, and future optimizer-adapter authors
Last verified against sources: 2026-08-27; see [`research-evidence.md`](research-evidence.md)

## Purpose and scope

`dal` is a local control plane around software-development tasks. It captures bounded task evidence, makes patterns queryable, and stages improvements for human decisions. It integrates with dsh v0 through repository instructions and a project-local skill. It does not mount a Cordis plugin or change a dsh profile.

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

Hard constraints:

- No network client, optimizer runtime, plugin installer, or shared-config writer ships in v0.
- Exact data syntax lives in JSON Schema, not duplicated prose or TypeScript literals.
- Every persistent mutation is local, explicit, and atomic at one-record granularity.
- dsh integrations respect Cordis lifecycle ownership: future registrations use plugin effects and durable facts use session events.
- Deterministic guardrails run before evaluators; model/judge evidence never grants capabilities or approval.
- Future evaluation or observability adapters consume sanitized projections only; the DSH session log and DAL immutable records remain authoritative.

## Context and interfaces

| Actor or system | Inputs | Outputs | Trust boundary and owner |
| --- | --- | --- | --- |
| Developer or dsh agent | Task facts and evidence references | Feedback JSON | Producer must summarize and redact; feedback contract owns fields |
| `dal` CLI | JSON records, filters, capsule paths, decisions | Local records and deterministic reports | Local process; never sends data |
| Local team store | Validated ingestion envelopes | Queryable JSON | Filesystem permissions and immutable-ID checks |
| dsh | `AGENTS.md`, project skill, future plugin events | Task execution and session facts | dsh owns session lifecycle; v0 does not alter composition |
| Human reviewer | Review and decision identity | Scoped approval or rejection | Only authority for sensitive actions |
| Future optimizer adapter | Sanitized exchange JSON | Candidate and evaluation receipt | Disabled in v0; application authority is separate |
| GEPA or SkillOpt | Future adapter data | Future candidate | Not installed or executed; external transfer requires approval |
| Guardrail evaluator | Structured, non-executing capability request | Immutable allow/deny/approval-required decision | Local deterministic policy; no requested tool execution |
| Evaluation harness | Pinned local fixture suite and target digest | Immutable scorecard and hard-stop disposition | Deterministic v0 runner; no model/provider/network |
| Future dsh guardrail plugin set | Protected tool calls, live agent control, and durable session events | Pre-execution decisions, safe results, and trajectory snapshots | Optional and unimplemented; DSH owns execution and session lifecycle |
| Future evaluation/observability adapter | Flushed sanitized trajectory plus independent side-effect receipts | Promptfoo input or OpenTelemetry/OpenInference projection | Optional; no authority; external transfer requires exact approval |

## Solution strategy

- Reuse dsh's project instruction chain and `.agents/skills` discovery for zero-shared-config integration.
- Keep structured feedback outside dsh's free-text `feedback/record` event because v0 needs validation, team aggregation, provenance, and secret rejection.
- Store immutable per-record envelopes rather than a mutable database. Query scans the bounded local directory; a database index can be added only when measured scale requires it.
- Treat improvements as staged state transitions. Evaluation evidence and application authority are separate records.
- Treat optimizer providers as adapters over versioned JSON, not as owners of policy or persistence.
- Pin capsule claims to source identity, digest, and refresh time.
- Put deterministic schema, privacy, capability, sandbox-declaration, budget, provenance, and approval checks ahead of score-based evaluation.
- Treat hard-stop scorecards as quarantine evidence, never as mutation instructions.
- Attach future DSH enforcement to the narrow owning waterfall or capability operation instead of inserting a control-flow gateway around the agent loop.
- Evaluate agent behavior from ordered Turn/Step/tool/approval events plus independently observed side effects; text output alone is insufficient.

Significant decision: [`decisions/0001-local-staged-improvement.md`](decisions/0001-local-staged-improvement.md).

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

### Guardrail and evaluation flow

1. A producer creates a bounded action request containing semantic operation identity, input trust, target digest, sandbox declaration, and budget; raw arguments and source content are excluded.
2. Schema and secret/PII checks run before persistence.
3. Deterministic policy evaluates capability, canonical repository URI containment, network, sandbox, budget, quarantine, and exact approval prerequisites. Traversal-shaped and encoded repository paths fail closed. It records one immutable decision per action ID, binds supplied approval content by digest, rejects stale retries when dynamic prerequisites change, and executes nothing.
4. The offline harness verifies fixture digests and contamination review, runs deterministic cases, and calculates the canonical scorecard metrics.
5. Any privacy leak, dangerous allow, policy/golden failure, contamination, drift, or budget breach emits a hard-stop scorecard. Post-change regression selects manual rollback; other failures quarantine the exact target digest.
6. Evaluated proposal stages reload the referenced scorecard, verify embedded suite/policy snapshots and current source identities, replay deterministic fixtures, derive metrics/thresholds/hard-stop state, and hash the candidate artifact itself. A passing scorecard can support later human review but cannot authorize or apply any artifact.

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
- dsh's workflow/session packages provide useful future event and cancellation vocabulary, but their observe-only events cannot guarantee a final structured write on hard process loss.

### Deployment model

`dal` is a repository-scoped control plane, not a Cordis plugin. Starting dsh in a new workspace yields no dal skill, no instructions, no CLI, and no `.dal/` store: the improvement loop does not exist there. Three deployment tiers:

| Tier | Shape | New-workspace behavior | Gate |
| --- | --- | --- | --- |
| 1. Repo-scoped (current) | `dal init` scaffolds stores, skill, and instructions into each workspace | Loop present per initialized workspace | None |
| 2. User-global install | `dal install user-global --approval <decision>` writes the skill under `~/.agents/skills/` and the fixed user-global `~/.dsh/AGENTS.md`; CLI on PATH | The workflow and skill are discovered in every workspace | An exact approved, unexpired `change_shared_harness_config` decision verified at the operation; differing existing content fails closed instead of overwriting |
| 3. Cordis plugin (future) | Opt-in dsh plugin with run/improvement modes, loaded by profile composition | The loop is part of dsh itself, workspace-independent | Install/mount approval plus the promotion gates |

Verified discovery roots at the pinned checkout: `packages/skill/skill-filesystem/src/index.ts:241-260` (project `.dsh/skills` and `.agents/skills`, then user `~/.dsh/skills` and `~/.agents/skills`) and `packages/context/agent-instructions/src/config.ts:19` (fixed user-global `AGENTS.md` in the harness home). The instruction loader reads files only — no programmatic instruction registry exists in the inspected version, so a plugin cannot register "rules" into the instruction baseline; plugin-side `agent.inject()`/`agent.steer()` is advisory and separate. The global `AGENTS.md` file is therefore the automated seam, written only by the approval-verified install command.

The evidence store stays repository-local in every tier; a user-level store for non-repository work and cross-workspace aggregation remain open future decisions.

### Usage model: run and reconcile

The intended operation is a batch, human-gated loop, not continuous autonomous self-improvement:

- **Run phase.** Agents operate normally in a workspace that contains the team's code or workflow files, project `.agents/skills`, and project `.dsh/` plugins/tools. No improvement code runs in the hot path — v0 has nothing to disable there; the loop is already batch. Each task ends with the agent writing its structured record: the feedback log and, for failure evidence, a run record. In v0 this agent-written record is the trace; automatic tool-call capture belongs to the future plugin.
- **Team sharing via VCS.** The evidence stores `.dal/outbox`, `.dal/store`, `.dal/runs`, and `.dal/clusters` are tracked in version control so everyone working in the workspace logs into the same history. Records are immutable per ID, so parallel writers only collide on duplicated IDs (a designed failure). Check, demo, and test artifacts under `.dal/` remain ignored.
- **Reconcile phase.** One human — a team lead or maintainer — runs `dal feedback summary` and `dal cluster run` over the accumulated records, reviews the clusters, drives proposals through the staged lifecycle (including the falsifiable prediction), evaluates in the sandbox path, and applies by committing the skill/tool/harness change to VCS. v0 applies nothing itself; the human commit is the application, and the proposal's `applied -> measured` transition records it.

This split keeps agents cheap and uninterrupted during the day and concentrates evaluation, governance, and application authority in a single human-reviewed batch.

A future Cordis integration remains an opt-in plugin set rather than one privileged gateway. It must use `inject`, `ctx.effect()` or `ctx.on()`, preserve model-visible/logged invariants, prove disposal, and remain independently removable. Installing or mounting it requires human approval.

Cordis is not plain dependency injection; it is a dynamic capability graph. `Context` answers which capabilities exist now, `Service` names what a module provides, `Plugin` owns the resources and their lifecycle, and `Inject` decides whether dependent capabilities deactivate when a dependency disappears. The engineering object has changed from "agent has tools" to "the runtime exposes a changing capability graph; a session binds to a scoped projection of that graph; plugins own capability lifecycles; dependencies determine activation." DAL's guardrail and capture plugins must be designed as graph members, not as a control-flow gateway.

DSH's composition graph is itself the self-improvement surface: stable component IDs, bundles as ordered patch layers, profiles composing bundles, presets defining capability levels, user overlays in the same patch language, service-driven activation, generation-based configuration, and sessions retaining their generation. A proposal therefore prefers structured composition patches over free-form harness edits — addressed by stable ID, with explicit diff, composition provenance, lifecycle boundaries, and a reconstructable effective configuration, evaluated as a new generation before promote/reject/rollback/retain-as-branch. DSH ships the substrate, not the RSI system: independent evaluator, sealed holdout, reversible promotion, regression gates, conflict resolution, and evaluator immutability are exactly what dal must add.

Profiles are user-global (`$DSH_HOME/profiles/<name>`; project-level `.dsh` profiles are unsupported at the pinned identity). The adopted pattern keeps the workspace as the single source of truth: plugin packages live in the workspace VCS next to skills and prompts, digest-pinned; installing them from those local paths into the root-level profile produces a derived installation generation. The install is a sensitive action with exact approval, and rollback is reinstalling the previous pinned generation. Everything the loop edits stays workspace-owned and VCS-recoverable; the profile is a reproducible deployment, not a source.

### Proposed optional dsh guardrail plugin set

This topology is design-only; no plugin below ships in v0.

| Responsibility | Verified DSH extension point | Required behavior and limit |
| --- | --- | --- |
| Tool policy, command inspection, and early path checks | `tools/pre-execute` waterfall | Inspect protected tool identity and arguments; return allow, deny, or ask without rewriting arguments. Shell, filesystem, and sandbox providers recheck at the operation that executes or mutates because a generic hook is not confinement. |
| Cooperative per-call deadline and execution metrics | `tools/execute` waterfall | Wrap dispatch and preserve cancellation semantics. Listener order is explicit; a signal is not a hard kill when a provider ignores it. |
| Secret/PII filtering and bounded model-facing output | `tools/post-execute` waterfall | Block or replace content/value before final `tool/result`; emit only rule IDs, truncation counts, and safe provenance. This cannot undo tool side effects or sanitize earlier user/tool arguments already in the session. |
| Final outcome observation | `tools/result` emit and durable `tool/result` session event | Observe the frozen result for counters and diagnostics; never treat `tools/result` as a fourth waterfall or enforcement point. |
| Repeated-failure and aggregate budget state | `session/event` plus `agent/pre-step` or `tools/pre-execute` | Reconstruct bounded per-agent state from durable events. Observers cannot veto committed events; enforce the next operation through a decision waterfall or cooperative cancellation. Advisory steering/injection remains logged and cannot replace a hard stop. |
| Permission escalation | `approval/request` waterfall | Supply one terminal, one-shot answerer and retain paired audit facts. A DSH grant does not satisfy DAL sensitive-action approval unless an adapter separately verifies exact action, scope, target digest, decision, and expiry. Headless absence fails closed. |
| Trajectory capture and export | Canonical session log, `session/event`, and explicit session flush | Pin DSH commit/profile/config, sequence range, event-format identity, and flush receipt. Treat Turn/Step/tool/approval events as recorded trajectory, not proof that external side effects are replayable. |

The event-to-evaluation path first flushes the session, then projects the selected event range into a privacy-safe trajectory and joins independent workspace/process side-effect receipts. The local deterministic evaluator remains the first authority. A future pinned Promptfoo custom provider may consume that snapshot for CI assertions; optional PyRIT attacks and Langfuse/Phoenix projections remain separate adapters. No adapter can mutate policy, approvals, the canonical log, or scorecards.

DSH already has an optional session-telemetry seam and an OTLP/HTTP log backend, disabled by default. Uploading modes can include complete message, tool, prompt, filesystem, and working-directory data unless a deployment mounts redaction rules. DAL integrations therefore require telemetry to remain disabled unless a separately reviewed sanitizer and exact external-transfer approval are active. OTLP logs are not assumed to be losslessly compatible with Langfuse or Phoenix trace/span models.

## Proposed self-improvement loop

Status: Partially implemented in v0: run-record ingestion, deterministic failure clustering, and the surface/prediction proposal boundary ship today; the run/improvement plugin modes and every model-dependent tier remain design-only. The boundary is explicit: **the agent may propose changes, but it should not control the evaluator, the holdout set, or its own permission boundary.**

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

Weights are reserved for a later stage, and the reserved slot is a local knowledge-base small model (an embedding/clustering tier for trace analysis), never silent fine-tuning of the main model. v0 ships no model at all.

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

The future plugin system has exactly two modes:

- **Run mode** — an ordinary agent session: the agent does work, uses tools, and every workspace action and outcome is recorded as durable evidence. No improvement code runs in the hot path.
- **Improvement mode** — dsh becomes a workbench: it reads the immutable record store, clusters failure evidence, runs a propose pipeline (GEPA or SkillOpt behind the existing optimizer-exchange schema), evaluates in a sandbox, and emits proposals for human promotion. Improvement-mode commands never execute requested actions and cannot touch the anchor.

### Proposer search seam

Optimizing workspace skills and the profile plugin runtime over logged sessions is a search/path-dependency problem, not a one-shot edit — closer to playing Go than to writing a patch once. The seam keeps the optimizer boundary unchanged: proposals become branches in a bounded search tree; deterministic evaluation is the value function; human promotion is the selection policy; rejected branches are retained as negative evidence; and alternative branches may be kept instead of discarded (the Darwin Gödel Machine archive pattern). An MCTS-style proposer in the ReST-MCTS* shape (select/expand/evaluate/backup over candidate changes) or a future model can be implemented behind the provider-neutral exchange without touching the anchor. Search depth, width, and evaluation count are bounded by policy budgets. This is future-only; v0 ships no search or model.

## Risks and technical debt

| Risk or debt | Impact | Current mitigation | Next decision trigger |
| --- | --- | --- | --- |
| Instruction compliance cannot guarantee final logs | Missing records | Completion workflow and explicit validation receipt | Need lifecycle-level enforcement in real dsh sessions |
| Pattern scanning has false negatives and positives | Secret exposure or blocked safe text | Reject before write, explicit rule receipt, manual data policy | Add audited scanner or organization policy |
| Directory scan queries are linear | Slow queries at high volume | Small local v0, deterministic files | Measured query latency or concurrent team store |
| Filesystem permissions are not encryption | Local disclosure | Restricted content policy and local-only default | Regulated or multi-tenant use |
| dsh, GEPA, and SkillOpt are pre-stable | Adapter drift | Pinned evidence and capsule freshness | Version update or first provider implementation |
| Sandbox evidence is provider-specific | False safety assumptions | v0 runs no optimizer and claims no sandbox proof | First sandbox evaluator implementation |
| DSH sandbox enforcement differs by platform and mode | A nominal permission level is mistaken for uniform filesystem, process, or network isolation | Pin runner/enforcement completeness; independently deny network; never treat `danger-full-access` as sandboxed | First DSH execution adapter |
| Prompt-injection detection is incomplete | Model follows malicious repository text | Capabilities derive only from deterministic structured policy, plus adversarial fixtures | First real dsh lifecycle guard |
| Fixed fixtures can be contaminated or gamed | Inflated score and unsafe proposal | Digests, split labels, contamination review, hidden-case rotation, human review | First optimizer experiment |
| Plugin provenance is digest-only in v0 | Signed or dependency compromise is missed | No plugin installation; quarantine and separate approval | First approved plugin installer design |
| Event observers run after commit | A detector notices a loop after the current effect has occurred | Enforce at the next `agent/pre-step` or tool decision; use cancellation only as cooperative containment | First repeated-failure hard-stop plugin |
| Trajectory or observability export contains sensitive session data | External disclosure | Default disabled; minimize and scan projections; require exact transfer approval | First Promptfoo, Langfuse, Phoenix, or remote collector adapter |

## Glossary

| Term | Meaning |
| --- | --- |
| Apply | Change a prompt, skill, Cordis plugin, or harness configuration using an approved candidate |
| Candidate | Frozen proposed text or bounded edit set plus base identity |
| Capsule | Compact source-bound context for model retrieval |
| Sensitive action | Shared config change, plugin install, external transfer, or candidate application |
| Store | Local directory of immutable stored-record JSON files |
