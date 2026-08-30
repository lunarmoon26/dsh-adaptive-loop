# Research and Evidence Note

Status: Evidence for the implemented v0 boundary and optional future adapters
Inspection date: 2026-08-27
Decision question: Which dsh/Cordis, loop-engineering, evaluation, observability, GEPA, and SkillOpt mechanisms should `dal` adapt while preserving local-first operation, human control, provenance, privacy, and compact context?

## Decision criteria

- A real dsh integration path that does not require shared configuration mutation.
- Durable structured records with explicit cancellation and blocked outcomes.
- A provider-neutral optimizer boundary rather than a premature optimizer dependency.
- Validation-gated and review-gated changes with no autonomous application.
- Compact context whose source drift is mechanically visible.

## Source availability and identity

| Requested source | Inspected identity | Availability and limitation |
| --- | --- | --- |
| `~/Workspace/dsh` | No directory at that path | The active checkout was found at `~/Workspace/deepseek-harness`; the substitution is explicit rather than silent. |
| User-supplied Chinese DSH/Cordis design note | `~/.openclaw/workspace/media/inbound/openclaw-staged-ecf557ba-f1c9-41a3-9dc3-973c7c57c7b7/DeepSeek_Harness_DSH_Agent_Harness_Cordis_...---e261d71f-7eae-49d5-8fa0-3ade974c6def.md`; SHA-256 `d31fe376abc970a0b41654c162b63a1e59ee9070a8b21ab3970fc32acd047ab5` | User-authored reference material, treated as untrusted and non-authoritative. Its DSH/Cordis claims were checked individually against the pinned local checkout. |
| `~/Workspace/deepseek-harness` | Git commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, tag description `dsh-v0.1.1-rc.2-dirty` | Relevant inspected files were not listed as modified. The checkout had unrelated user changes and generated/untracked files; none were edited or treated as evidence. |
| Vendored Cordis in dsh | `@deepseek-ai/cordis` `4.0.0-rc.7`, upstream commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` | dsh carries documented local lifecycle and loader hardening; findings apply to this vendored form. |
| `~/Workspace/lunarmoon26.github.io/_private` | Parent repo commit `de8a68902cbc80752a6de2c9c733a73abf3b1f60`, dirty only in unrelated package/agent files | Usable dsh, Cordis, and loop notes were present. They are secondary synthesis and were checked against source where consequential. |
| `~/Workspace/gepa` | Git commit `2360e7ec87d70d149efe3c677447f16f0b932336`, package `0.1.4`, clean checkout | Static interface inspection only; no optimizer was run. |
| `~/Workspace/SkillOpt` | No directory; workspace name and content searches returned no SkillOpt checkout | This is an exact local evidence gap. No local code was invented or attributed. |
| `microsoft/SkillOpt` public fallback | Default-branch commit `eb8c1e7bcbccdd80f9d422f12018fcd8e84ce19a`, package `0.2.0` | BX identified the upstream. Public source and docs were fetched read-only. This does not substitute for an unavailable local checkout or prove a released API is stable. |
| Loop-Driven Development article | <https://generativeprogrammer.com/p/from-test-driven-to-loop-driven-development>, fetched 2026-08-27; article dated 2026-06-11 | Direct article content was inspected. |
| Global engineering skills | `document-driven-development`, `research-driven-development`, `lightweight-architecture`, `skill-creator`, and `bx`, inspected 2026-08-27 | Local workflow guidance, not product dependencies. |

## BX evidence and current limitation

Historical notes from the initial research phase recorded successful BX discovery through `/Users/haochuanzhang/.local/bin/bx`, including the linked article, dsh/Cordis evolution, GEPA, and SkillOpt. That earlier credential state was not revalidated and is not evidence for the guardrail option-research slice.

The BX results were used for discovery and cross-checking, not as implementation proof. Direct article content, local source, and pinned upstream source provided the consequential evidence.

For the evaluation-and-guardrails slice, the user reported that BX had no configured key and required that limitation to be recorded. BX was therefore treated as unavailable: no BX query was attempted and no BX finding is claimed for this slice. New option research used direct, read-only GitHub release APIs and pinned primary README files.

For the staged-note refinement slice, BX was available and used only to discover relevant official pages for Promptfoo, PyRIT, Langfuse, and Phoenix. Consequential mechanism claims were checked against those official pages, and release/tag identities were pinned independently through GitHub's read-only API. Search output is not treated as runtime or integration proof.

For the attribution-and-benchmark slice (2026-08-28), BX was available: the operator's shell profile exports the API key and it was loaded into the session shell for the searches. BX context searches identified the Self-Harness and harness-disclosure papers, Terminal-Bench 2.0 and the Harbor framework, and the harness-engineering reference list below. Paper mechanisms and repo identities were cross-checked against the arXiv HTML pages and GitHub repositories themselves; search summaries are discovery evidence, not mechanism proof.

## Staged DSH/Cordis note verification

The attachment proposes a useful direction but overstates several current DSH guarantees. The verified design keeps the composable extension points while removing claims of a four-waterfall pipeline, absolute replay, uniform sandbox enforcement, built-in external approval integrations, and native evaluation-framework compatibility.

| Attachment claim | Verification status | Direct evidence and qualification |
| --- | --- | --- |
| Cordis supports independently mounted lifecycle-owned guardrail plugins | Confirmed | `deepseek-harness/docs/architecture.md:9-35` and `docs/cordis-primer.md:7-34` define plugin composition, service injection, reversible effects, and waterfall short-circuiting. |
| Tool execution has four live extension waterfalls: pre-execute, execute, post-execute, result | Partly false | `deepseek-harness/docs/tool-execution-pipeline.md:6-60` and `packages/core/tools/src/index.ts:142-197` define three waterfalls: `tools/pre-execute`, `tools/execute`, and `tools/post-execute`. `tools/result` is a contained synchronous `emit` over a frozen final result; it cannot veto or rewrite. |
| A pre-execute plugin can enforce command and path policy | Confirmed with limits | `packages/core/tools/src/index.ts:1473-1505` permits allow/deny/ask before dispatch. `packages/core/tools/README.md:190-197` states that the hook cannot rewrite logged arguments. Filesystem and sandbox owners must recheck policy at their own execution operations; a generic hook is not the final confinement boundary. |
| A post-execute plugin can redact or truncate results before model reuse | Confirmed as an extension point, not as an installed DAL plugin | `packages/core/tools/src/index.ts:1742-1780`, `packages/core/tools/README.md:176-188`, and `docs/tool-execution-pipeline.md:21-60` show that post-execute may block or replace final model-facing content/value before durable `tool/result`. This cannot undo side effects that already occurred inside the tool. |
| DSH provides an append-only, absolutely replayable event stream | Qualified | `docs/architecture.md:53-96` and `packages/core/session/src/index.ts:604-654` confirm durable Turn/Step/message/tool events and post-commit observation. Persistence is write-behind until `session/flush`; replay reconstructs recorded context and outcomes, not external side effects, and the pre-release session format has no compatibility promise. |
| Event listeners can detect loops and enforce global budgets directly | Partly confirmed | `packages/guard/repeat-tool-reminder/README.md:5-35` implements advisory identical-call detection; `packages/guard/timeout-policy/README.md:5-36` implements cooperative per-call deadlines. No aggregate turn/token/time or repeated-failure hard budget was found. `session/event` is observation-only; a future hard stop must act at `agent/pre-step`, `tools/pre-execute`, or cooperative cancellation and record that intervention. |
| DSH permission escalation is plugin-answerable | Confirmed with limits | `packages/interaction/user-approval/README.md:5-13,57-62` defines one-shot `approval/request` waterfall answerers, fail-closed absence, and no durable grant. ACP and API proxy provide answerers in source; no Slack, webhook, or ticket answerer was found. The request omits tool arguments, so it cannot by itself satisfy DAL's exact action/scope/digest approval contract. |
| `read-only`, `workspace-write`, and `danger-full-access` are uniformly sandboxed permission tiers | Qualified | `packages/interaction/permission-presets/src/index.ts:109-117,183-192` defines the modes, but `danger-full-access` is unconfined and its shipped matching preset disables prompts. `packages/sandbox/sandbox-local/README.md:5-19,36-42` documents Linux bwrap/Landlock, macOS Seatbelt, partial Windows ACL enforcement, partial older Landlock enforcement, and fail-closed unavailability. DSH's sandbox vocabulary makes no network-isolation guarantee. |
| DSH trajectories naturally map losslessly to Promptfoo, Langfuse, Phoenix, or PyRIT | Unverified as an integration claim | Turn/Step/tool/approval events support a useful projection, but no native adapter for these products exists in the inspected DSH checkout. `packages/session/session-telemetry/README.md:17-35` exposes a redaction waterfall and OTLP-log sink contract; `session-telemetry-otel` emits logs, not a lossless trace/span model, is best-effort, and ships no redaction rules. Any adapter is a sanitized projection, never the canonical log. |

Design consequence: use the DSH event log as provenance-bearing input after an explicit flush, preserve event sequence and DSH source/config identity, and verify filesystem/process side effects independently. A missing event range, unflushed tail, denied call followed by execution evidence, privacy leak, or mismatched side-effect receipt is a hard stop. Text-output grading remains supplemental.

## Evaluation and guardrail options inspected

Inspection date: 2026-08-27. Static primary-source review only; no project was installed or run.

| Source and identity | Directly evidenced mechanism | Fit and tradeoff for `dal` v0 | Recommendation |
| --- | --- | --- | --- |
| `promptfoo/promptfoo` `0.122.1`, commit `e1cd4007e0d30b9aca8de003490603c87ee7a355` | CLI/Node evaluation engine with custom providers, deterministic JavaScript assertions, structured response metadata, trace/tool assertions, CI output formats, red teaming, and token accounting | Best fit for a future Node/TypeScript CI adapter that projects a flushed DSH trajectory and independent side-effect receipts. No native DSH provider was found. The broad package can invoke providers, subprocesses, remote sharing, or red-team models unless configuration and execution confinement disable them. | Primary future CI experiment candidate; use pinned local providers/fixtures, `--no-share`, zero external requests, and deterministic DAL hard stops. Do not add it to v0. |
| `NVIDIA/garak` `v0.16.0` | Probe -> generator -> detector -> evaluator -> report pipeline covering prompt injection, leakage, jailbreak, malware, package hallucination, and related failures | Strong red-team taxonomy and structured attempt reporting. Python/plugin ecosystem is substantial; many generators require model downloads, APIs, credentials, or network. Its detectors are evidence, not authorization. | Adapt adversarial categories; experiment only in a future isolated, approved evaluator. |
| `microsoft/PyRIT` `v1.0.1`, commit `d55692149c0e1164f5f057e63d4e7fdae62acfb5` | Python red-team framework with custom targets, multi-turn attacks, scorers, and tree-of-attacks/pruning strategies | Better suited than the deterministic v0 runner to optional long-session adversarial exploration. Typical attacks require attacker/scorer models and can multiply requests, cost, sensitive transcripts, and failure modes. No DSH target was found. | Optional future red-team experiment after the deterministic Promptfoo/DAL path; require an isolated custom target, explicit budgets, sanitized data, and separate network/provider approval. |
| `langfuse/langfuse` `v4.22.0`, commit `99fb6fa7dbbfab50a83e62a7fff25315a7057b2d` | OpenTelemetry-based observations grouped into traces and sessions, with span hierarchy and session replay views | A sanitized DSH event projection could supply session/turn/step/tool observations, but this is a lossy observability view. Hosted export crosses a data boundary; self-hosting still adds operational and retention surface. DSH's existing exporter emits OTLP logs rather than this trace model. | Optional observability adapter only; keep disabled/local by default, never use it as policy or canonical provenance, and require approval before external export. |
| `Arize-ai/phoenix` `arize-phoenix-v20.4.0`, commit `a015c6f69ccb23f1eb2d2a31a25097b42f9dba00` | OpenTelemetry/OpenInference traces with session IDs and agent/tool/guardrail/evaluator span kinds | A neutral OpenInference projection can represent agent/tool spans and support later analysis, but exact DSH event order, approval facts, and side effects need attached identities or separate receipts. It is not a replay engine for DSH. | Optional local/self-hosted observability adapter; preserve the DSH log as authority and approval-gate any external destination. |
| `open-policy-agent/opa` `v1.19.1` | Declarative rules answer policy queries; the integrating service separately enforces allow/deny | Clean policy-decision/enforcement separation and mature rule tooling. A separate binary/server or WASM/Rego integration is disproportionate for a fixed local v0 policy and creates another supply-chain/runtime boundary. | Adapt the decision/enforcement separation; retain typed local checks until policy complexity justifies OPA. |
| `gitleaks/gitleaks` `v8.30.1` | Regex/entropy secret detection over git, directories, files, or stdin with redaction, rules, baselines, exit codes, and JSON/JUnit/SARIF reports | Useful rule-corpus and independent repository scan. External Go binary/config lifecycle is unnecessary for per-record JSON-path enforcement; reports can themselves expose findings unless redaction is configured. | Keep no runtime dependency; consider optional CI defense-in-depth later. |
| `data-privacy-stack/presidio` `2.2.364` | Pluggable PII recognition and anonymization using regex, checksums, rules, context, NER, and optional external models; explicitly warns detection is incomplete | Broad PII coverage and calibration model. Python/NLP/container footprint and language/model configuration exceed v0; automated detection still needs layered protection. | Adapt narrow deterministic PII fixtures and precision/recall metrics; defer provider integration. |
| `sigstore/cosign` `v3.1.3` | Digest-bound signing and verification for OCI and other artifacts, keyless transparency-log flows, key/KMS modes, attestations, and offline bundle verification | Strong future plugin artifact identity and attestation evidence. Default keyless flows use OIDC, public services, registries, and potentially public PII; offline verification still needs trusted-root lifecycle and a large external binary. | Require digest pins now; evaluate offline signature verification only with the first approved plugin installer. |

Primary references: tagged release records and tagged README or official documentation pages at the repositories above. Release APIs established the inspected versions and commits; official docs established the mechanisms. Documentation pages without a tag-pinned URL were treated as current-site evidence and not silently attributed to an older release. No runtime or security-quality claim was inferred from release recency, popularity, or badges.

## Model-versus-harness attribution and benchmark options

Inspection date: 2026-08-28. Discovery via BX context search; mechanisms pinned to arXiv HTML pages and GitHub repositories. Nothing below was installed or run.

| Source and identity | Directly evidenced mechanism | Fit for post-improvement attribution | Recommendation |
| --- | --- | --- | --- |
| Self-Harness paper and code, arXiv `2606.09498`, code `github.com/qzzqzzb/Self-Harness` | Three-stage loop — Weakness Mining from clustered execution traces, Harness Proposal with minimal bounded edits, Proposal Validation with held-in evidence and held-out regression gates — improves a fixed model by editing only its harness. Up to +40.6 points across nine model–benchmark pairs while the model backend, tool set, budget, benchmark environment, and evaluator stay fixed. | Direct prior art for dal's staged improvement loop; its experimental discipline (model fixed, harness edited, held-out gates) is exactly the attribution design dal requires. | Adapt the propose–validate–promote structure and fixed-dimension discipline; do not treat it as an dal dependency. |
| "Stop Comparing LLM Agents Without Disclosing the Harness", arXiv `2605.23950` | Documents scaffold-only swings: the same model moves from 45.9% to 55.4% on SWE-bench Pro when the harness changes; independent monitoring reports up to 11–15 points of harness-only variation on SWE-bench Verified, dwarfing reported model deltas. | Empirical justification for mandatory harness disclosure and the Model × Harness matrix before any gain claim. | Adopt disclosure and the factorial matrix; cite as motivation. |
| Terminal-Bench 2.0, Stanford × Laude Institute, open-source | 89 manually verified terminal tasks in containerized environments with pinned dependencies; deterministic pytest end-state verification; no LLM judges; task and scaffold are decoupled so one suite can run many agent adapters. | Best available agent-level benchmark for post-improvement claims; pinned environment and deterministic graders match the required fixed dimensions. | Primary future agent benchmark candidate, evaluated through the Harbor framework. |
| Harbor, open-source agent evaluation framework | Container-based evaluation and optimization framework for agents; rewrite of the original Terminal-Bench harness with improved reliability, observability, and agent adapters (Claude Code, Codex CLI, OpenHands, and others). | Evaluator infrastructure for running the same pinned task suite against many model+harness cells. | Evaluate as the future benchmark runner when agent-level evaluation is approved. |
| SWE-bench Verified | Deterministic patch/task suites for repository-level software repair with pass/fail tests. | Capability and regression evidence at the software-engineering layer; one matrix cell dimension. | Adopt alongside Terminal-Bench for coding-specific claims. |
| AppWorld | Multi-application workflow tasks with structured end-state verification. | Workflow/application-layer capability evidence. | Optional third benchmark for workflow claims. |
| `EleutherAI/lm-evaluation-harness` | Model-only benchmark harness with 200+ standard tasks, vLLM/HF backends, pinned task versions. | Model-only ablation layer: isolates raw model gains with no agent scaffold, making the harness delta attributable. | Use for the model-only row of the ablation; not an agent benchmark. |
| `modelscope/evalscope` (EvalScope, Alibaba) | Unified LLM/VLM/agent evaluation framework covering benchmarks and model-native tools. | Alternative model-only and model-native-tool ablation layer. | Evaluate alongside lm-eval-harness before picking one. |
| W&B Weave (`wandb/weave`) | Versioned prompts/models/data, systematic evaluations, side-by-side comparison across multiple metrics, sweeps over configuration dimensions. | Maps directly onto the Model × Harness matrix: versioning every cell dimension and comparing cells side by side. | Candidate for matrix tracking/visualization; never the authority that decides promotion. |
| Langfuse `v4.22.0`, Phoenix `v20.4.0`, Opik | Open-source observability/experiment platforms with prompt/config versioning, traces, and experiment comparison. | Optional experiment bookkeeping for the matrix; local-first with the same external-transfer rules as before. | Optional; canonical authority stays with dal records. |
| `ai-boost/awesome-harness-engineering` list | Indexes self-improving harness implementations: `neosigmaai/auto-harness` (mine benchmark failures, edit harness, gate against regressions), `autocontext` (multi-generation evaluation loops distilling playbooks), `retro-harness` (RHO: harness optimization from past trajectories via self-validation and pairwise self-preference), and Continual Harness (reset-free online self-improvement). | Reference implementations to study before designing the dal harness-improvement adapter; several implement exactly the failure-mine → bounded-edit → regression-gate loop. | Study for design reuse; adopt nothing without source inspection and the dal promotion gates. |

Search-based discovery was cross-checked against the arXiv HTML pages and GitHub repositories named above; secondary blog summaries were used for orientation only. No model, benchmark, or harness above was executed, and none becomes an dal dependency or authority.

## Self-improvement loop references

Inspection date: 2026-08-28. Discovery via BX context search and direct fetch; mechanisms pinned to the pages themselves.

| Source and identity | Directly evidenced mechanism | Fit for the dal improvement loop | Recommendation |
| --- | --- | --- | --- |
| `karpathy/autoresearch`, default branch `master`, head `228791fb499afffb54b46200aca536f79142f117` (2026-03-26), no license | Public repo in which AI agents run single-GPU nanochat training research automatically; an automated research loop rather than a coding-agent harness | Orientation for autonomous multi-step loop orchestration; not a coding-agent improvement loop | Study for loop orchestration ideas only; no license, so treat as reference material, never reusable code. |
| OpenAI cookbook: "Build an Agent Improvement Loop with Traces, Evals, and Codex", <https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop>, fetched 2026-08-28 | Traced runs → human and LLM feedback over the traces → automatically generated Promptfoo eval suite → Promptfoo validation gate over current behavior → HALO optimization pass over traces, feedback, and eval results → Codex handoff to implement the recommended harness changes | Direct template for the loop stages: evidence comes from traces, acceptance passes an evaluation gate, and implementation is handed off separately from evaluation | Adapt the trace → feedback → generated evals → gate → propose ordering; keep the dal deterministic gate and human promotion as authority. |
| "AI Harness Engineering: A Runtime Substrate for Foundation-Model Software Agents" (the "Agentic Harness Engineering" work), arXiv `2605.13357` | Eleven harness component responsibilities — task interface, context manager, tool registry, project memory, task state, observability, failure attribution, verification, permissions, entropy auditing, intervention recording — a four-level H0–H3 ladder, and a trace-based evaluation protocol recording eight evidence classes | Formal substrate for the editable-surface/anchor split: failure attribution, verification, permissions, and entropy auditing are first-class harness components owned outside the proposer | Adapt the component decomposition and evidence classes when designing the improvement-mode workbench; do not adopt as a dependency. |

The loop reference is: run tasks → collect traces and outcomes → cluster failures → propose one falsifiable change → predict improvements and regressions → evaluate in sandbox → accept or reject → version and monitor. The governing rule remains that the agent may propose changes but must not control the evaluator, the holdout set, or its own permission boundary.

## Recursive self-improvement ladder and search

Inspection date: 2026-08-28. The operator's five-level RSI note was treated as untrusted reference material; each level was checked against the pinned sources below.

### Five levels and the bounded-RSI conclusion

| Level | Scope | Evidence state |
| --- | --- | --- |
| 0 | In-run self-correction (reflection, retry, evaluator-optimizer, critic/reviser, fix-on-test-failure) | Real, but not persistent learning: the next run may be unchanged. |
| 1 | Cross-run non-parametric improvement (prompt, tool descriptions, skills, routing, retrieval, memory, stop conditions) | The most realistic, verifiable, enterprise-adoptable layer. GEPA evolves prompts from full execution trajectories; the OpenAI improvement-loop cookbook proposes, ranks, and implements harness changes from real traces/feedback/evals and recommends keeping human approval early. |
| 2 | Harness or agent code self-modification | Gödel Agent, SICA, and Darwin Gödel Machine explore this. DGM keeps an archive of self-modified versions and selects empirically instead of walking one possibly degenerate path. Evidence comes from coding benchmarks and controlled sandboxes, not unrestricted production. |
| 3 | Model weight adaptation | SEAL generates its own training data/config and fine-tunes; its paper observes catastrophic forgetting across successive self-edits. Attribution, rollback, unrelated-capability drift, benchmark overfitting, and the need for sealed holdouts and retention evals all get harder. |
| 4 | Open-ended RSI (modifying its own optimization method, architecture, and goal formation) | No representative study shows open-ended, general, long-term-stable, enterprise-governable RSI. The accurate claim is **bounded empirical self-improvement under an externally fixed objective and evaluation process**, not an unrestricted recursive explosion. |

Recursive Language Models (arXiv `2512.24601`) use "recursive" for inference-time context processing over long inputs — not persistent policy improvement; do not conflate the two.

### Pinned sources

| Source and identity | Directly evidenced mechanism | Fit for dal |
| --- | --- | --- |
| Weco AI, "AIDE²: First Evidence of Recursive Self-Improvement", <https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement>, fetched 2026-08-28; base agent AIDE, arXiv `2502.13138` | Bi-level loop: an outer agent optimizes the inner research agent's code for 100 unattended iterations; discovered seven successively stronger agents, a novel search algorithm, a 16× prompt reduction, and emergent anti-reward-hacking (63%→34%) that beat two years of hand-tuning on held-out benchmarks. Defines an RSI ladder (Level 0–3) with an "ignition test" for acceleration; positions AIDE² at Level 1. | Direct prior art for the run/reconcile outer loop and hidden-holdout selection; its "most proposals fail" distribution is the expected reject-heavy shape. |
| Darwin Gödel Machine (DGM), arXiv `2505.22954`, ICLR 2026 | Population archive of self-modified coding agents; parents selected proportional to score and inversely to exploration; empirical validation on coding benchmarks; Polyglot 14.2%→30.7%. | Prior art for the search seam: keep alternative branches and select empirically instead of a single degenerate path. |
| ReST-MCTS*, arXiv `2406.03816`, code `github.com/THUDM/ReST-MCTS` | Process-reward-guided MCTS tree search collecting reasoning traces for iterative self-training; beats Best-of-N and Tree-of-Thought at equal budget; multi-iteration improvement. | Concrete AlphaGo-style search prior art for the future proposer seam (select/expand/evaluate/backup over candidate changes). |
| Operator-supplied scholar profiles | Bingchen Zhao (`lEcqFJEAAAAJ`), Dixing Xu (`8Ez_u30AAAAJ`), Yuxiang Wu (`ZN1uIRQAAAAJ`) | Profile identities fetched 2026-08-28; associations to Gödel Agent, DGM, and related work recorded from the operator's note and to be confirmed per paper before any claim. |
| Gödel Agent, SICA, SEAL | Mentioned in the operator's note | Not yet independently pinned; treat as leads to verify before citing. |

### dsh profile placement and the local-path install pattern

The pinned checkout (`packages/boot/app-boot/src/profile.ts:5`) defines a profile as a directory under `$DSH_HOME/profiles/<name>`; current web documentation agrees that profiles are ordered stacks of plugin-bundle patches under the user's overrides, with the invoking directory as workspace root. **Project-level `.dsh` profiles are not supported** at the inspected identity: profiles are user-global, while skills and instructions are workspace-local.

The adopted pattern: the workspace VCS keeps the plugin packages (source of truth, digest-pinned) next to skills and prompts; installing them from those local paths into the root-level profile produces a derived installation generation. The install is a sensitive action with exact approval; rollback is reinstalling the previous pinned generation. This preserves workspace ownership of everything the loop edits while the profile remains a reproducible deployment of workspace-pinned sources.

### Search-algorithm seam

Optimizing workspace skills and profile plugin runtime over logged sessions is a search/path-dependency problem, not a one-shot edit. The dal seam for it: proposals become branches in a bounded search tree — deterministic evaluation is the value function, human promotion is the selection policy, rejected branches are retained as negative evidence, and alternative branches may be kept instead of discarded (DGM archive). An MCTS-style proposer (ReST-MCTS* pattern) or a future model is implementable behind the provider-neutral optimizer exchange without changing the immutable anchor. Nothing below ships in v0.

### Gradient-style optimizers for the skills + plugins control plane

Inspection date: 2026-08-29. Discovery via BX context search; identities pinned via arXiv/official pages/GitHub.

Decision question: which text-space "gradient-style" optimizers should dal adapt now that the control plane is explicitly **skills and plugins** (Markdown skill documents + workspace plugin sources), and what run/trace evidence does each require?

| Source and identity | Directly evidenced mechanism | Fit for the dal control plane | Recommendation |
| --- | --- | --- | --- |
| SkillOpt, Microsoft, `microsoft/SkillOpt` (Yang et al., 2026, arXiv `2605.23904`), official docs at `microsoft.github.io/SkillOpt` | Treats the **skill document as the trainable state of a frozen agent**: rollout = forward pass over scored tasks; reflect = a separate optimizer model turns scored trajectories into bounded edit patches (the "gradient"); edit selection with `learning_rate = max edits` (the "gradient clipping"); validation-gated acceptance into `best_skill.md` with a reject buffer; epoch-wise meta update refines the optimizer itself. The deep-learning analogy is explicit in the docs (weights ↔ skill.md, loss ↔ edit patches). | Exact control-plane match: our `refund-workflow/SKILL.md` is literally the trainable document. The validation gate maps to our sealed holdout + e2e after-batch; the reject buffer maps to the branch archive. | **Adapt as the primary optimizer seam** — borrow the rollout/reflect/clip/validate/accept loop; keep dal's frozen evaluator, approval-bound model calls, human promotion, and digest-pinned best-skill commits. |
| SkillGrad, arXiv `2605.27760` (May 2026) | Gradient-descent-inspired skill optimization: mini-batch rollouts yield outcomes plus trajectories as **loss evidence**; a diagnoser converts them into textual update signals; **textual momentum** stabilizes successive patches; skill patching applies bounded edits. Outperforms training-based skill-evolution baselines by ~6.7 pts on SpreadsheetBench Verified and WikiTableQuestions. | Skills-as-parameters with explicit trajectory-level loss evidence; momentum is a natural extension to SkillOpt's plain reflect step. | **Experiment** — adopt textual momentum and trajectory-level loss evidence; validate on the tau-style workspace before claiming transfer. |
| GEPA, `gepa-ai/gepa`, arXiv `2507.19457`, ICLR 2026 Oral | Genetic-Pareto reflective prompt optimizer on DSPy: the evaluator returns **Actionable Side Information (ASI)** alongside the score (error messages, reasoning traces, profiler output, constraint violations); a reflector LLM reads full execution traces and mutates textual parameters; candidates live on a **Pareto frontier** across task subsets (multi-objective: accuracy, cost, constraint satisfaction). Optimizes prompts, code, and agent architectures. | Covers the **plugin code** half of our control plane (prompts + sources), and its ASI contract is the right shape for our deterministic grader (we already carry per-check `detail` strings). Pareto retention matches the DGM/branch-archive design. | **Adapt for plugin/prompt candidates** — reuse ASI + frontier mechanics; it sits behind the same provider-neutral optimizer exchange as the roadmap's existing GEPA mention. |
| TextGrad / TextGrad 2, Stanford, `zou-group/textgrad`; failure-mode survey arXiv `2607.20668` ("From Agent Failures to Text Policies: What Works and What Breaks") | Textual gradients flow feedback through a graph of text variables with TextLoss definitions; TextGrad 2 handles compound systems; the survey documents where agentic textual-gradient loops break (attribution across steps, feedback quality, loop instability). | General framework rather than a skills-specific loop; useful as the theoretical vocabulary, and the failure survey feeds our guardrail design. | **Reject as a dependency** — adapt vocabulary; SkillOpt/SkillGrad already package the same mechanics with validation gates. |
| TPGO, arXiv `2604.20714` | Textual Parameter Graph Optimization for multi-agent systems: agents, tools, and workflows become optimizable **nodes in a Textual Parameter Graph**; textual gradients propagate across node dependencies; GRAO meta-learning clusters historical error patterns and retrieves successful past strategies for reuse. | Direct structural match for "skills + plugins": the skill document and each plugin package are graph nodes, dependencies (skill → tools, bundle → plugins) are edges, and GRAO's error-pattern clustering is our failure-cluster store. | **Experiment later** — the graph structure is the right long-term shape once the plugin modes ship evidence; single-skill first. |

### Trace requirements the optimizers share

Every option above consumes **scored rollouts with attributed trajectories**, not pass/fail aggregates. The concrete evidence deltas for the dal run records:

1. **Step-level trace projection** — ordered per-run sequence of (turn, step, tool name, outcome code); names and codes only, never raw arguments or results (SkillOpt reflect, SkillGrad loss evidence, GEPA ASI all read this shape).
2. **Check-level grader deltas** — per failed check: id, deterministic `detail`, and digests of the goal state vs the actual state, so a textual gradient can name the exact field mismatch (our e2e's `goal:bookings` extra-fields failure is the canonical case).
3. **Batch and cluster linkage** — `batch_id` and `cluster_id` on every run record so mini-batch selection and error-pattern retrieval (GRAO) work over the store.
4. **Harness attribution pins** — candidate/base digests of the skill and plugin sources active during the run (already present as prompt/policy digests; extend to the edited surfaces).
5. **Failure-attribution benchmark discipline** — the multi-agent attribution benchmark (arXiv `2604.22708`) grades traces by whether they identify the responsible agent and earliest decisive error step; adopt its trace-shape requirements when the run-mode plugin records multi-agent sessions.

All five are additive to `run-record.v1` (optional sections, digest-safe, privacy-scanned) — no optimizer runs until the trace shape exists, and none of the optimizer mechanics above may touch the frozen evaluator, permissions, budget, or promotion policy.

Shipped v0 (2026-08-29): requirements 1–4 landed as optional `run-record.v1` sections — `trace` (ordered capped step projection with tool outcomes, emitted by the run-mode recorder), `checks` (per-check grader deltas with `goal_sha256`/`actual_sha256` and deterministic `detail`), `batch_id`, and `context.harness_pins` (edited-surface digests); the tau-style e2e driver populates `checks`/`batch_id`/`harness_pins`. Requirement 5 (multi-agent attribution discipline) remains future until the run-mode plugin records multi-agent sessions.

### Awesome-list cross-check (scaffolding improvement)

Cross-checked against `selfimproving-agent/awesome-Self-Improving-Agents` (README fetched raw at `main`, 2026-08-29), section 2.1. The list confirms the primary tier above and adds a second tier:

| Source and identity | Mechanism worth noting | Recommendation |
| --- | --- | --- |
| Trace, `microsoft/trace`, arXiv `2406.16218`, NeurIPS 2024 | "Trace is the next AutoDiff": generative optimization over **execution traces** with rich feedback, plus a trained optimizer (AutoOpt) — the trace-as-differentiation mechanism family our trace requirements are designed for. | **Watch/experiment** — validates the trace-first ordering: ship the trace shape, then an AutoOpt-style trained optimizer is a drop-in experiment. |
| Semantic Backpropagation, arXiv `2412.03624`, `HishamAlyahya/semantic_backprop` | Correct textual backprop through agentic systems: gradients are attributed to the **responsible step**, fixing the attribution problem that breaks naive TextGrad loops on agents. | **Adapt the attribution rule** — matches trace requirement 5 (earliest decisive error step); keep the rule, not the framework. |
| metaTextGrad, NeurIPS 2025, `zou-group/metatextgrad`; Scaling Textual Gradients via Sampling-Based Momentum, ICML 2025, arXiv `2506.00400` | Optimizing the optimizer itself, and momentum over sampled textual gradients — the same mechanics as SkillOpt's meta-update and SkillGrad's textual momentum. | **Experiment** — both are refinements inside the SkillOpt seam, not separate frameworks. |
| VASO, arXiv `2606.05395` (2026) | Formally verifiable self-evolving skills for physical agents — skills + verification gates as first-class. | **Watch** — the verification-first posture matches dal's fail-closed style once a plugin-mode optimizer exists. |
| SePO, arXiv `2606.04465`, `taowangcheng/SePO`; SAGE, arXiv `2606.18902` (2026) | Self-evolving prompt agents with code; stochastic prompt optimization via agent-guided exploration. | **Watch** — prompt-level variants; lower priority than the skills seam. |
| APO "Gradient Descent + Beam Search", EMNLP 2023, `microsoft/LMOps` | The original textual-gradient-plus-beam-search prompt optimizer. | **Historical anchor** — superseded by the tier above. |

No change to the primary decision (SkillOpt seam + GEPA for plugin/prompt candidates); the cross-check adds the attribution and meta-update mechanics to the experiment list and re-confirms that the run-record trace deltas come first.

### Workflow benchmark selection

Inspection date: 2026-08-28. Discovery via BX context search; identities pinned via the GitHub API or official pages.

| Benchmark and identity | Directly evidenced mechanism | Fit for the dal closed-loop claim |
| --- | --- | --- |
| τ-bench, `sierra-research/tau-bench`, MIT, `main@59a200c6d575d595120f1cb70fea53cef0632f6b` (2026-03-18); Tau²-Bench 2026 expansion | Repetitive retail/airline/telecom customer-service workflows; agent talks to an LLM-simulated user, calls domain API tools that read/write a database, and must obey a written policy. Success is graded by comparing the **final database state against an annotated goal** — objective, deterministic, no LLM judge — plus a `pass^k` reliability metric over repeated identical tasks. | The canonical closed-loop workflow benchmark: bounded task class, deterministic grader, policy adherence, and pass^k matches the stochastic-discipline rules. This is the pattern the `benchmarks/tau-style-workflow` workspace models synthetically. |
| Terminal-Bench 2.0 (through the Harbor framework), Stanford × Laude | 89 containerized terminal tasks with pinned dependencies and deterministic pytest end-state verification; task and scaffold are decoupled. | Second closed-loop candidate for terminal-operations workflows; deterministic graders, containerized environment snapshots. |
| SWE-bench Verified | Real GitHub issue resolution graded by unit tests; no LLM judge. | Deterministic but open-loop-shaped: each issue is novel, so it fits capability/regression evidence better than repetitive-workflow RSI claims. |
| GAIA | Multi-step web/file assistant tasks; string match with LLM-judge fallback. | Judge fallback weakens determinism; use only with the judge declared and pinned. |
| OSWorld | Desktop GUI tasks graded by VLM screenshots. | VLM grader is model-dependent; out of scope until a pinned deterministic subset exists. |
| WebArena | Multi-step web tasks across self-hosted site clones. | Deterministic end-state checks; optional later web-workflow class. |

Recommendation: adopt the τ-bench pattern as the first benchmark workspace (done: `benchmarks/tau-style-workflow`, synthetic task class, deterministic grader, policy invariants, dal evaluation suite) and treat Terminal-Bench 2.0 as the second class when containerized execution is approved. No external benchmark was installed or run.

### Community DSH RSI frameworks (source-audited)

Discovery date: 2026-08-29 (GitHub `dsh-plugin` topic API + BX). Source audit date: 2026-08-29 — each repo was cloned read-only at the pinned commit and audited by hand with file:line evidence. Nothing was installed, built, or executed.

| Framework (license, commit) | What the source shows | Strengths worth adopting | Decisive weakness vs dal |
| --- | --- | --- | --- |
| `huchunlinnk/deepseek-desk-rsi`, MIT, `6da2cedd` | A git-loop with six named tools; only four are real code (`perceive`/`checkpoint`/`rollback`/`verify`/`parity`/`propose`); `integrate` and `repair` are agent-discipline prose. Deterministic gates: `verify` = shell exit code (`tools/verify.js:31-37`), `parity` = exact plugin-name set membership against a regenerable manifest (`tools/parity.js:67-78`, `scripts/gen-parity.mjs`). | Mechanically regenerable parity manifest from upstream bundle patches; uniform bounded shell-executor result object (`lib/exec.js`); git-native checkpoints; real-git e2e tests (`scripts/e2e-loop.mjs`). | **Every anchor is proposer-editable**: the verify command is a call argument, `parity.json` and the loop prompt and rollback tool are plain repo files (`propose.js` stages `git add -A` with no path limits). "ok=true is required" is prompt prose, not code — failing gates do not block propose. No holdout, no journal, no budget, no sandbox; rollback is unguarded `git reset --hard`. |
| `timwhitez/dsh-self-evolving`, Apache-2.0, `d0f3c804` | Spec-first engine whose safety machinery is real but whose loop is unproven: pilot used `Math.random` stubs (`evidence/pilot/STATUS.json`), calibration holds 3 nop Harbor trials (`QUARANTINED_NOT_ACCEPTED`), formal search and gate8 are `BLOCKED_NOT_STARTED`, and the gate8 verifier is a hardcoded fail-closed stub (`gate8-acceptance.ts:277-289`). | Nonce-bound one-shot Loader admission (`admission.ts:242-298,592-747` — a candidate cannot forge its own boot receipt); separate-process sealed holdout with `0700` dir, seed commitment, Merkle root, one-shot lock (`sealed-service/service.ts`); exactly-once intent→effect→receipt saga (`engine.ts:179-194`); hash-chained evidence journal with honest negative `STATUS.json` files; deterministic promotion (paired cluster bootstrap, CI95 gate, `stats.ts:44-103`); route-locked model gateway with micro-USD double-entry budget. | **No human approval gate** (deliberately), LLM-performed failure clustering, anchors protected by sandbox convention rather than separate principals, rollback specified but not implemented. |
| `ZK-Andy/dsh-continual-evolve`, MIT, `d6826e4c` | A shipped plugin: versioned harness state (`prompt|memory|skill|subagent` entries) under `$DSH_HOME/evolve/`, refined from trajectories by an LLM planner, with JSONL+snapshot audit layers, a benchmark loop, and deterministic inverse-edit rollback (`rollback.ts:9-73`). | Executor/scorer separation with rubric ciphertext at rest (`evaluate.ts:59-85,196-201`); code-owned non-regressive decision over LLM leaf scores with failed-cell exclusion and material-drift `caseHash` (`score.ts:14-18,136,174-213`); rollback with `rollbackOf` audit chain; non-configurable secret patterns and duplicate/scope guards that outrank the LLM (`promotion.ts`, `wrapup.ts:301-355`); draft→calibrating→frozen case lifecycle with quarantine auto-regression (`autocase.ts`). | **Anchors are conventions, not invariants**: the same-user `rubric.key` is readable, benchmark statements and config are plain files, and the agent's bash tool can edit them (`rubric.ts:74-93`). LLM-judged scoring leaf; local-scope edits auto-applied without approval (`auto.ts:439`); no sandbox/network/budget ceiling; **raw trajectories sent to the provider unredacted** (`review.ts:105-125`). |
| `fakechris/dsh-harness-ops`, MIT, `58c04e33` | Dual isolated `DSH_HOME` slots; candidate build + staging smoke (HTTP 200, manifest, e2e) then atomic `ln -sfn` switch; rollback = previous slot (`mechanism-design-npm.md`). | Acceptance-gated atomic generation switch with the old generation kept bootable — the strongest deploy/rollback pattern in the set. | Acceptance is operational smoke only; no behavioral benchmark, sealed holdout, or human decision record. |
| `fuhefei/dsh-sentinel`, commit `ce614037` | Condition-driven wake with an append-only JSONL sidecar as the sole carrier of truth, edge-triggered firing, at-least-once delivery with a `delivered` watermark, and a one-duty-owner lease per `DSH_HOME` (`docs/invariants.md`). | Edge-trigger semantics and the lease pattern for the future run-mode trigger plugin. | Not an improvement loop; no evaluation or promotion at all. |
| `ciceroyang/dsh-plugin-starter`, MIT, `3ba820d` | Plugin scaffold generator with a `--verify` smoke run and CI template. | The template+verify shape for future dal workspace scaffolding. | Scaffolding only. |
| `klarkxy/dsh-plugin-autoevo` | No license (`NOASSERTION`) — not cloned; reference material only. | Phase vocabulary only. | Not audited; never reusable code. |

### Audit synthesis: how dal stays superior

Across all audited frameworks, dal remains the only design where **anchors are invariants, not conventions**: evaluator, sealed holdout, permissions, maximum budget, promotion policy, audit log, and rollback are rejected at proposal-validation level and never proposer-editable — desk-rsi edits them freely, continual-evolve leaves them bypassable via same-user bash, and self-evolving protects them by sandbox convention with an unimplemented gate8. dal is also the only one with (a) a human approval decision verified at the operation, (b) deterministic failure clustering implemented and tested, (c) trajectories that never send raw transcripts to a provider, and (d) an executed, gate-wired benchmark workspace — while self-evolving's bigger machinery is quarantined behind honest `STATUS.json` files.

Adopted from the audit into the contract and roadmap: nonce-bound admission receipts, exactly-once effect sagas, the separate-principal sealed holdout, code-owned scoring over LLM leaf judgments with drift re-marking, inverse-edit rollback with audit-chain links, the A/B generation switch, and sentinel-style edge-triggered wake with a store lease. Full adoption list lives in the roadmap.

## Sources inspected and findings

### DeepSeek Harness and Cordis

Direct evidence:

- `deepseek-harness/docs/architecture.md:9-35` states that every dsh part is a Cordis plugin and describes ordered profile/bundle/patch composition.
- `deepseek-harness/docs/architecture.md:53-61,92-100,106-130` distinguishes durable session events, live agent events, capability events, and supported extension mechanisms.
- `deepseek-harness/docs/cordis-primer.md:7-13,28-44` defines plugin shapes, service injection, typed event modes, waterfall delegation, and reversible effects.
- `deepseek-harness/vendor/cordis/src/registry.ts:164-185` shows `ctx.inject` reload behavior and plugin loading with config validation.
- `deepseek-harness/vendor/cordis/src/events.ts:224-259` shows that omitting `next()` vetoes a waterfall and that listeners are owned effects.
- `deepseek-harness/packages/context/agent-instructions/src/config.ts:11-45` makes `AGENTS.md` and `CLAUDE.md` default project instruction candidates.
- `deepseek-harness/packages/skill/skill-filesystem/src/index.ts:241-258` discovers project `.dsh/skills` and `.agents/skills` roots.
- `deepseek-harness/packages/skill/skill-filesystem/src/index.ts:252-259` also discovers user-global roots: `~/.dsh/skills` (user-dsh, `skipSystem`) and `~/.agents/skills` (user-agents), so user-installed skills appear in every workspace without a profile edit.
- `deepseek-harness/packages/context/agent-instructions/src/config.ts:12,19` loads the fixed user-global `AGENTS.md` from the harness home (`$DSH_HOME` or `~/.dsh`) in addition to project candidates.
- `deepseek-harness/packages/context/agent-instructions/src/index.ts` and `config.ts` show the loader reads instruction files only (`AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md` at project roots plus the fixed user-global file). No programmatic instruction registry or provider exists in this package, so plugins cannot register instruction content into the baseline; `agent.inject()`/`agent.steer()` remain advisory, logged, and separate from the instructions baseline.
- `deepseek-harness/packages/feedback/command-feedback/src/index.ts:56-76` defines a log-only free-text `feedback/record` event and a trigger-independent producer.
- `deepseek-harness/packages/feedback/command-feedback/README.md:66-73` explicitly lists no retrieval/aggregation, no structured fields, and no forced durability barrier.
- `deepseek-harness/packages/core/session/src/types.ts:142-177` gives durable `completed`, `aborted`, `blocked`, `error`, `max-tokens`, and `interrupted` turn outcomes.
- `deepseek-harness/packages/workflow/workflow/src/types.ts:57-87` gives workflow `completed`, `cancelled`, and `error` results.
- `deepseek-harness/packages/workflow/workflow/README.md:21-29,53-59` says workflow lifecycle events are observe-only and scripts have no journaling/resume or recursive workflow hook.

Tests inspected:

- `deepseek-harness/packages/feedback/command-feedback/tests/command-feedback.spec.ts:123-180,209-245` proves one authoritative feedback event, model isolation, repeated entries, and no event on pre-cancelled dispatch.
- `deepseek-harness/packages/context/agent-instructions/tests/agent-instructions.spec.ts:309-515` covers project instruction order and candidate restrictions.
- `deepseek-harness/packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:158` and `packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts:647` cover terminal ordering and cancellation cleanup.

Recommendation: adapt project instructions and local skills now. Keep team feedback in a separate structured store. Experiment later with an opt-in Cordis plugin that appends a structured session event and awaits `session/flush`; do not claim current workflow events can enforce a final record after process loss.

### Private source notes

Useful secondary material:

- `_private/cordis-from-zero.md:176-312,453-519,649-748,938-1073` derives Context, Service, Plugin, events, lifecycle ownership, and dynamic injection.
- `_private/harness-breakdown-07-deepseek-harness.md:100-139` summarizes append-only session history, model-visible/logged behavior, session composition, and sandbox limits against dsh commit `b150a551...`.
- `_private/harness-breakdown-dsh-cordis-assembly.md:72-169` summarizes stable-ID patching, whole-config replacement, layer order, service-driven activation, and user patch overlays against the same commit.
- `_private/andrew-ng-loop-engineering-tri-loop-architecture.md:33-78,105-109` describes nested agent, developer, and external loops and warns about context drift and eval overfitting.

Recommendation: use these notes as orientation only. Exact v0 claims remain anchored in code, tests, and primary docs.

### Loop-Driven Development article

Direct evidence from the fetched article:

- A loop-driven engineer designs the trigger, goal, context, harness, verifier, and state around a wider unit of work.
- A harness governs one agent run; a loop is the control system around it; a factory is a system of loops.
- Deterministic tests, builds, type checks, linters, contracts, benchmarks, screenshots, traces, and CI provide backpressure.
- A verifier distinguishes a convergent loop from repeated prompting.
- More autonomy requires stronger checks, while the human chooses goals, context, permissions, acceptable risk, and final judgment.

Recommendation: adapt the trigger/goal/harness/verifier/state decomposition and preserve an external verifier. Reject the implication that repeated self-review alone establishes safety or completion.

### GEPA

Direct evidence:

- `gepa/src/gepa/oa/engine.py:33-96` defines a lean `Engine(config) -> run(Task, EvalServer) -> Result` protocol and separates evaluation-call budget from proposer-token cost.
- `gepa/src/gepa/oa/task.py:21-80` keeps the task as pure data and refuses unsupported multi-component flattening.
- `gepa/src/gepa/optimize_anything.py:94-202,225-247` accepts a candidate, evaluator, train/validation/test data, objective, background, and bounded configuration; higher scores are better and held-out tests remain outside the eval server.
- `gepa/src/gepa/core/adapter.py:15-35,83-143,145-217` defines the richer batch score/trajectory/reflection adapter and its aligned-output invariants.
- `gepa/src/gepa/oa/config.py:23-111` documents budgets, output/run directories, and sandbox configuration.

Negative evidence and risk:

- GEPA is `0.1.4` and exposes both lean OA and richer legacy/core paths.
- Candidate, evaluator info, logs, and output directories can contain sensitive data.
- A subprocess sandbox does not by itself establish network isolation or safe candidate application.

Recommendation: experiment later behind a provider-neutral task/evaluation/result boundary modeled on the lean Engine protocol. Add the richer GEPA adapter only when component-level traces and reflective datasets are required.

### SkillOpt

The local checkout was unavailable. The following is public-fallback evidence pinned to `microsoft/SkillOpt@eb8c1e7b...`:

- `README.md` and `docs/guide/training-loop.md` define rollout -> reflect -> aggregate -> select -> bounded update -> validation gate.
- `skillopt/types.py` defines plain serializable edits, patches, rollout results, failure summaries, and provenance fields.
- `skillopt/evaluation/gate.py` implements a pure higher-is-better accept/reject decision; strict improvement is the default acceptance rule.
- `skillopt/optimizer/skill.py` applies bounded append/insert/replace/delete edits and reports each edit outcome.
- `skillopt_sleep/types.py` separates harvested session digests, normalized tasks, replay results, bounded edits, and staged reports.
- `skillopt_sleep/staging.py` states that the cycle stages proposals and requires a separate adopt step; it redacts secret patterns, pins live and proposed digests, writes atomically, and revalidates targets before adoption.
- `docs/sleep/README.md` warns that real backends send transcript-derived content externally, redaction is defense in depth, and adoption remains review-driven.

Negative evidence and risk:

- Main-branch behavior is newer than the declared `0.2.0` release and explicitly preview-grade.
- Some configurations can disable validation or use unconditional slow updates.
- Optimizer prompts and session-derived records can cross provider boundaries.
- Validation-score improvement does not authorize mutation of a shared harness.

Recommendation: adapt bounded edit receipts, separate validation evidence, base/candidate digest pinning, and stage-then-adopt. Do not adopt automatic nightly harvesting, external provider calls, or auto-adopt in v0.

## Synthesis

| Source | Adopt or adapt | Defer or reject |
| --- | --- | --- |
| dsh/Cordis | Project instructions, local skill discovery, three narrow tool waterfalls, one-shot approval seam, durable trajectory facts after flush, reversible future plugin effects | Shared profile patch, automatic plugin install, fourth result waterfall, absolute replay, uniform sandbox/network claim |
| Loop-Driven Development | Explicit trigger, goal, harness, verifier, state, and human judgment | Repeated prompting without independent evidence |
| Promptfoo | Primary future CI experiment over a custom local DSH trajectory provider, deterministic assertions, and local reports | v0 dependency, native-DSH claim, remote sharing/provider defaults, authorization role |
| PyRIT | Optional multi-turn adversarial experiment with a narrow custom target and explicit budgets | Default CI dependency, implicit provider/network use, authorization role |
| Langfuse/Phoenix | Optional sanitized observability projections after local deterministic evaluation | Canonical-log replacement, lossless-replay claim, unapproved external export |
| GEPA | Pure task/evaluator/result boundary and explicit budgets | Runtime dependency, optimizer execution, application authority |
| SkillOpt | Bounded edits, validation evidence, rejected-candidate history, stage/adopt split, digest pins | Transcript harvesting, provider calls, auto-adoption |
| Global DDD/RDD skills | One fact owner, current/future labels, requirement-to-evidence closure, pinned source identity | Empty documentation taxonomy or prose as executable proof |

## Confidence and unresolved evidence

- High confidence: v0 can integrate through dsh project instructions and project-local skills without changing shared composition.
- High confidence: current dsh free-text feedback is not a substitute for the requested structured team contract.
- High confidence: the inspected DSH version provides `tools/pre-execute`, `tools/execute`, and `tools/post-execute` waterfalls; frozen `tools/result` observation; durable Turn/Step/tool events; and optional one-shot approval answerers.
- High confidence: DSH event replay does not reproduce external side effects, sandbox enforcement is platform/mode specific, and no inspected sandbox contract establishes network isolation.
- High confidence: optimizer evaluation and human application authority must remain separate.
- Medium confidence: Promptfoo is the best first external CI experiment because its Node/custom-provider and deterministic trajectory assertion surfaces fit a sanitized DSH event projection; no adapter was implemented or run.
- Medium confidence: the provider-neutral exchange can map cleanly to future GEPA and SkillOpt versions; both interfaces are pre-stable and need a version-pinned adapter experiment.
- Unknown: the exact SkillOpt state the user expected in the absent local checkout.
- Unknown: which dsh transport and UI should expose structured feedback when a Cordis plugin is implemented.
- Unknown: the final DSH-to-Promptfoo trajectory format and independent filesystem/process side-effect receipt required for a reproducible CI experiment.
- Unknown: whether a future deployment prefers a local Langfuse or Phoenix projection; neither is required by the v0 design.
- Unknown: team record volume and whether a SQLite index is justified.

No optimizer, evaluation framework, model, DSH runtime, sandbox, approval transport, or observability collector was executed. No dsh profile, shared instruction, plugin installation, or external data destination was changed.
