# Tau-style workflow benchmark workspace

This directory is a **target test-benchmark workspace** for the dsh-adaptive-loop framework. It models the τ-bench pattern (Sierra Research, `sierra-research/tau-bench`, MIT, pinned at `main@59a200c6d575d595120f1cb70fea53cef0632f6b`, 2026-03-18): a closed-loop, repetitive workflow class (retail refunds and booking changes) with a **deterministic end-state grader** — no LLM judge, no network, no model.

Layout:

| Path | Role |
| --- | --- |
| `tasks/` | The bounded task set: instruction, initial state, annotated goal state, and the written policy the agent must obey |
| `grader/grade.ts` | Deterministic local verifier: compares the final state against the annotated goal and checks policy invariants; exits 0/1 and prints a JSON verdict |
| `.agents/skills/refund-workflow/SKILL.md` | The workspace skill the improvement loop will optimize (deliberately minimal v1) |
| `.dsh/plugins/dal-workflow-tools/` | Workspace plugin package **source** (pinned, never auto-installed; installing into a profile is an approval-gated sensitive action) |
| `dal/fixtures/` | Guardrail-verifier fixtures, sample run records, and grader result states |
| `dal/suite.json` | The dal evaluation suite that pins and exercises this workspace |

Run the deterministic checks:

```sh
pnpm exec tsx benchmarks/tau-style-workflow/grader/grade.ts \
  benchmarks/tau-style-workflow/tasks/task-001-refund.json \
  benchmarks/tau-style-workflow/dal/fixtures/result-pass.json
pnpm run dal eval run benchmarks/tau-style-workflow/dal/suite.json --store .dal/check/benchmark-evaluations
```

The workspace-level `.dal/` evidence stores are created at runtime and are not committed here. Improvement targets in this workspace are the skill and the plugin package source — both VCS-owned and digest-pinned; the profile is only ever a derived, approval-gated installation of them.
