# DSH Adaptive Loop Roadmap

Version 0 deliberately stops at local validation, immutable evidence, deterministic non-executing policy, offline evaluation, and human-governed state transitions. Nothing below is implemented or authorized by the current CLI.

## Next decision points

### Opt-in dsh/Cordis integration

- Recognize the current deployment reality: dal is repository-scoped, so a fresh workspace has no dal skill, instructions, CLI, or store and cannot improve anything. Decide between the available tiers — repo-scoped vendoring, user-global skill deployment under `~/.agents/skills` with a fixed user-global `AGENTS.md` (sensitive action, exact human approval required), and the future Cordis plugin.
- Add a project-owned Cordis plugin only after lifecycle, disposal, cancellation, flush, and model-visible/logged behavior are proven against a pinned dsh version.
- Decide the store location before the plugin ships: repository-local evidence (current) versus a user-level or team store, with migration and rollback for any change.
- Split guardrails by verified ownership: `tools/pre-execute` for allow/deny/ask command and early path policy, `tools/execute` for cooperative deadlines/metrics, and `tools/post-execute` for model-facing secret/PII rejection and truncation. Treat `tools/result` as observation only.
- Recheck filesystem, subprocess, sandbox, and network policy in the operation that creates the side effect; do not mistake a generic hook for confinement.
- Derive repeated-failure and aggregate turn/step/tool/token/time budgets from durable events, then enforce the next operation through `agent/pre-step`, `tools/pre-execute`, or cooperative cancellation. Keep steering/injection advisory and logged.
- Adapt DSH's one-shot `approval/request` waterfall only after exact DAL action/scope/digest/expiry verification can be joined from trusted operation metadata; no external approval transport is implicit.
- Keep installation and profile mounting separate from implementation; each requires an exact human approval.
- Preserve standalone JSON/CLI operation as the recovery path.

### Real sandbox execution

- Re-verify the structured guardrail decision at the executor boundary (done: `dal verify run` re-verifies and refuses unconfined execution).
- Keep one fail-closed seam: the dsh `sandbox` seam backend is chosen (done — dal consumes `dsh-sandbox`/`dsh-sandbox-local` `0.1.1-rc.2` on Cordis `4.0.1`), so platform runners come from the provider; verify Linux bwrap/Landlock and the Windows ACL runner on their hosts when available, and add symlink/path-race tests plus execution receipts before claiming sandbox proof beyond the executed macOS evidence.
- Do not add a general shell runner.

### Self-improvement workbench

- Split the future plugin system into two modes: run mode (the agent operates and every workspace action/outcome is recorded; no improvement code in the hot path) and improvement mode (dsh becomes a workbench that clusters past evidence, runs a propose pipeline, sandbox-evaluates, and emits proposals for human promotion). **Shipped v0**: the `@lunarmoon26/dal-modes` bundle splits exactly this way — `@lunarmoon26/dal-run-record` projects session events into privacy-safe run records (on by default; no raw prompt/message/argument/result content), and `@lunarmoon26/dal-improve-tools` registers the deterministic workbench tools (off by default; cluster, prepare payload, summarize, branch evaluate, reset status — nothing approval-gated). Profile mounting stays an approval-gated `install_or_mount_plugin` operation; the rest of this section is future work.
- Pin the editable surface — prompt, tool descriptions, skills, memory policy, routing, stop/retry logic, harness code — one bounded, versioned, digest-pinned change per proposal.
- Pin the immutable anchor the proposer can never control: evaluator, sealed holdout, permissions, maximum budget, promotion policy, audit log, rollback mechanism.
- Reserve weights for a later local knowledge-base small model (embedding/clustering tier for trace analysis), never silent fine-tuning of the main model.
- Build the failure-clustering plugin in tiers: canonical deterministic fingerprints at ingestion, local embedding clustering, and a budgeted LLM classifier over cluster representatives only — never raw traces; cluster records are immutable and privacy-scanned before use.
- Target closed-loop, repetitive workflow classes first: open-ended creative coding is an open-loop problem and gets no RSI claim. Benchmarks are bounded per task class — externally fixed objective, deterministic grader, held-out cases, and policy budgets; only cross-run evidence (Level 1+) counts as improvement.
- Design the proposer as bounded search over candidate branches (select/expand/evaluate/backup, ReST-MCTS* shape; retain alternatives, DGM archive shape) behind the provider-neutral exchange. Breadth, depth, and evaluation counts are policy-bounded. The first branch ships: `dal propose prepare|run` invokes the model only under a verified `send_data_externally` decision bound to the sanitized payload digest and emits schema-validated drafts; multi-branch search remains future work.
- Add deeper MCTS rollouts on top of the branch archive: selection descends with UCB1 at every level; expansion adds one governed proposal child; simulation grades with the deterministic dev cases (later, runs the candidate skill in the seam sandbox); backpropagation walks ancestors updating visits and accumulated scores so node values reflect their subtree (path-dependency credit); terminal conditions are depth caps, budget caps, hard-stop quarantine, or human promotion. Every rollout multiplies approval-bound model calls and confined evaluations, so rollout count, depth, and evaluation budget stay policy-owned.
- Deploy profile changes from workspace-owned plugin packages: keep plugin sources in the workspace VCS, digest-pinned, and install them from local paths into the root-level profile as an approval-gated derived generation; rollback reinstalls the previous generation. Track upstream for project-level `.dsh` profiles. Consider the community A/B slot pattern (`fakechris/dsh-harness-ops`): keep the previous generation bootable and switch atomically only after acceptance.
- Study the community RSI frameworks before building the workbench (pinned in the research note): `deepseek-desk-rsi` (bounded perceive/integrate/verify/parity/repair/propose loop with an upstream parity gate), `dsh-self-evolving` (evidence-first, crash-resumable, auditable lineage, Harbor evaluation, one-shot loader admission), `dsh-continual-evolve` (versioned rollback-safe harness state from trajectories with a benchmark validation loop), and `dsh-sentinel` (condition-driven run-phase triggers). Audit their source; adopt ideas, never code.
- Adopt the audited hardening list from the contract: one-shot sealed reveal; nonce-bound admission receipts; exactly-once effect sagas; rubric isolation with drift re-marking; code-owned scoring over LLM leaf judgments; inverse-edit rollback with audit links; and the A/B generation switch with a bootable previous slot.
- Add a separate-principal sealed-holdout service (own OS principal, `0700` store, seed commitment, Merkle root, one-shot lock, controller gets opaque handles plus a count only) before any paid or model-based evaluation.
- Add a store lease (one duty owner per evidence store) and edge-triggered, at-least-once wake semantics for the future run-mode trigger plugin.
- Study `karpathy/autoresearch`, the OpenAI agent-improvement-loop cookbook, the AI Harness Engineering ladder, AIDE², the Darwin Gödel Machine, and ReST-MCTS* (pinned in the research note) before designing the workbench.

### Optimizer experiments

- Implement one provider-neutral, prepare/evaluate-only adapter behind the existing exchange schema. **Shipped v0**: `dal optimize prepare|evaluate` — a deterministic SkillOpt-shaped adapter (sanitized training set from run records; bounded-edits validation gate with gradient clipping, anchor resolution, and reconstructed candidate digest). The reflect step and rollout remain approval-gated and human-promoted.
- Primary gradient-style seam decided by research (pinned in the research note): **SkillOpt** (`microsoft/SkillOpt`) adapted as the skills-document optimizer (rollout → reflect → clip → validation gate → best-skill commit), **GEPA** (ICLR 2026 Oral, `gepa-ai/gepa`) for plugin-code/prompt candidates via its ASI + Pareto frontier, with **SkillGrad**'s textual momentum as an experiment and **TPGO**'s parameter-graph shape later.
- The trace evidence shape shipped v0: `trace`, `checks` (goal/actual digests + detail), `batch_id`, and `context.harness_pins` are additive `run-record.v1` sections (see the research note); what remains before any optimizer runs is populating `trace` from real run-mode sessions and the multi-agent attribution discipline.
- Compare pinned GEPA and SkillOpt versions using synthetic/local datasets and explicit budgets.
- Keep train/validation/test separation, rejected candidate history, base/candidate digests, and human adoption.
- Never let an optimizer alter policy, tests, scorecards, approvals, or application authority.
- After the deterministic path exists, experiment with bounded search proposers (MCTS-style tree over candidate changes, retained alternative branches) on one closed-loop task class, with the evaluation budget fixed by policy.

### Optional evaluation integrations

- Prototype Promptfoo `0.122.1` as the primary CI adapter candidate with a pinned local TypeScript provider over flushed, sanitized DSH trajectories and independent side-effect receipts. Disable sharing/remote inference and retain DAL deterministic hard stops as authority.
- Evaluate PyRIT `v1.0.1` only as an optional multi-turn red-team driver after the deterministic CI path exists; isolate attacker/scorer providers and bound requests, cost, data, and target permissions.
- Evaluate Langfuse `v4.22.0` and Phoenix `v20.4.0` only as optional local-first observability projections. Keep the DSH log canonical, declare projection loss, and approval-gate external collectors.
- Evaluate garak only in an isolated, explicitly approved experiment where provider, network, model, and data-transfer boundaries are visible.
- Treat any model/judge output as supplemental evidence, never authorization.
- Enforce statistical evaluation discipline before any model-based metric is promoted: per-case multi-seed rollouts, matched paired baseline comparison, separate `pass@1`/success-rate/variance reporting, per-suite capability/regression/safety/adversarial metrics, full model/prompt/tool/harness versioning, and rejection of best-of-N cherry-picking.
- Require the Model × Harness attribution matrix before claiming any self-improvement gain: evaluate every (model, harness) cell with pinned tool versions, environment snapshot, task set, random seeds, inference parameters, context policy, and grader version; never attribute a confounded model+harness delta to either side alone.
- Benchmark shortlist for post-improvement claims: Terminal-Bench 2.0 (containerized, pinned, deterministic graders) through the Harbor framework, SWE-bench Verified, and AppWorld for agent-level evidence; `lm-eval-harness` or EvalScope for model-only ablations; W&B Weave, Langfuse, Phoenix, or Opik for the pinned experiment matrix. Study the Self-Harness, auto-harness, autocontext, and retro-harness reference implementations before designing the dal adapter.
- Consider OPA only when measured policy complexity exceeds typed local rules.

### Supply-chain verification

- Before the first plugin installer design, define exact package/version/digest pins, trusted roots, SBOM/vulnerability evidence, and offline signature verification.
- Evaluate gitleaks as optional CI defense in depth and cosign for offline artifact verification; do not make external public services implicit.

### Store scale and governance

- Measure directory-scan latency and record volume before adding SQLite or synchronization.
- Add authenticated reviewer identities, retention receipts, and auditable tombstones only with a migration and rollback plan.
- Encryption, multi-tenant authorization, and organization policy remain separate security decisions.

## Promotion gates

Future work cannot advance from experiment to integration without:

1. updated schemas, contracts, threat model, and requirement evidence;
2. pinned provenance and uncontaminated offline/adversarial/regression scorecards;
3. deterministic policy and privacy checks passing before probabilistic evaluation;
4. a human review decision;
5. a separate exact approval at any shared, external, destructive, install, or application boundary;
6. a documented rollback path tested at the claimed integration layer;
7. for DSH trajectory claims, a pinned event-format/source identity, successful flush receipt, complete selected sequence range, and independent side-effect evidence;
8. for observability or evaluation export, privacy tests over the exact projection and an explicit local-only or approved external destination.
