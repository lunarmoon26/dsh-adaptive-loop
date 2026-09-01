# Tau-style workflow benchmark workspace

This directory is a **target test-benchmark workspace** for the dsh-adaptive-loop framework. It models the τ-bench pattern (Sierra Research, `sierra-research/tau-bench`, MIT, pinned at `main@59a200c6d575d595120f1cb70fea53cef0632f6b`, 2026-03-18): a closed-loop, repetitive workflow class (retail refunds and booking changes) with a **deterministic state-and-effect grader** — no LLM judge.

Layout:

| Path | Role |
| --- | --- |
| `tasks/` | The bounded task set: agent facts plus evaluator-only goal state and required/forbidden effect rules; `policy.md` remains agent-visible |
| `grader/grade.ts` | Deterministic verifier `2.0.0`: compares final state and effect evidence against the task contract; exits 0/1 and prints a JSON verdict |
| `.agents/skills/refund-workflow/SKILL.md` | The workspace skill improvement surface; the G0 baseline is retained under `dal/fixtures/` |
| `.dsh/plugins/dal-workflow-tools/` | Workspace plugin package **source** (pinned, never auto-installed; installing into a profile is an approval-gated sensitive action) |
| `dal/fixtures/` | Guardrail-verifier fixtures, sample run records, and grader result states |
| `dal/suite.json` | The dal evaluation suite that pins and exercises this workspace |
| `e2e-topology.ts`, `run-e2e.ts` | Approval-bound three-container runner: minimal read-only candidate, journal-owning service, and isolated grader |

Run the deterministic checks:

```sh
pnpm exec tsx benchmarks/tau-style-workflow/grader/grade.ts \
  benchmarks/tau-style-workflow/tasks/task-001-refund.json \
  benchmarks/tau-style-workflow/dal/fixtures/result-pass.json
pnpm run dal eval run benchmarks/tau-style-workflow/dal/suite.json --store .dal/check/benchmark-evaluations

# Refusal tasks require evaluator-owned effect evidence.
pnpm exec tsx benchmarks/tau-style-workflow/grader/grade.ts \
  benchmarks/tau-style-workflow/tasks/task-003-policy-refusal.json \
  benchmarks/tau-style-workflow/dal/fixtures/result-refusal.json \
  benchmarks/tau-style-workflow/dal/fixtures/effects-refusal.jsonl
```

For e2e runs, the candidate sees only its projected task, policy, skill, and the exact composition patch. The service owns the checksummed append-only journal and exposes typed workflow endpoints; the grader alone receives an attempt-staged full task and an authenticated state/effect snapshot. The candidate never receives the repository, goal state, grader source, journal, or receipts. The exact rendered patch, rollout count, full task digests, driver sources, staged inputs, and immutable execution image are bound to an immutably stored manifest that is revalidated before each model call and referenced by every receipt. Summary comparison verifies that manifest, receipt, and persisted run-record path/digest chain; rejects reused evidence or task/candidate/model/generation/image reassignment; and recomputes metrics from receipt-bound business outcomes before attribution. `--generation g2` is rejected while G2 remains source-only.

The workspace-level `.dal/` evidence stores are created at runtime and are not committed here. Improvement targets are the skill and separately governed plugin source — both VCS-owned and digest-pinned; a profile remains a derived, approval-gated installation.
