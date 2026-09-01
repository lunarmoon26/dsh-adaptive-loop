# DSH Adaptive Loop

> 中文文档：[README.zh.md](README.zh.md)

`dal` is a local, human-governed evidence and improvement loop for **closed-loop, repetitive agent workflows** — task classes with bounded objectives, observable state transitions, and deterministic graders (customer-service-style workflows, ops routines, benchmarkable business processes). Open-ended creative coding is an open-loop problem and is explicitly out of scope for improvement claims: with no bounded objective to evaluate against, dal makes no recursive-self-improvement claim there.

Version 0 validates structured task feedback, stores immutable local records, evaluates non-executing capability requests, runs pinned offline safety/regression suites, clusters failures deterministically, seals a holdout, produces governed model proposal drafts, searches candidate branches with UCB1, executes confined deterministic verifiers, and records human-controlled proposal state.

It does **not** invoke an LLM or optimizer outside the approval-bound proposer, execute a requested action unconfined, install a plugin, change dsh configuration without an approved decision, or apply a candidate.

## What it is for (and not for)

- **For:** repetitive, closed-loop workflow classes with deterministic graders — the `benchmarks/tau-style-workflow` workspace is the reference pattern.
- **Not for:** open-ended coding or research as an improvement target; those tasks still log feedback and run records, but no improvement claim is made on them.
- **Anchors stay human-owned:** evaluator, sealed holdout, permissions, maximum budget, promotion policy, audit log, rollback — the proposer can never edit them.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm run dal feedback validate tests/fixtures/feedback/completed.json
pnpm run dal feedback ingest tests/fixtures/feedback/completed.json --store .dal/demo-feedback
pnpm run dal feedback summary --store .dal/demo-feedback --format json
pnpm run dal policy check tests/fixtures/guardrail/allowed-read.json --store .dal/demo-guardrail
pnpm run dal eval run tests/fixtures/evaluation/v0-suite.json --store .dal/demo-evaluations
pnpm run dal capsule check capsules
pnpm run check
```

Expected results: the feedback, local-read policy decision, capsules, and evaluation suite pass; ingestion creates one immutable record; summary reports one completed record. Repeating identical feedback or policy ingestion is idempotent. All commands run locally.

## Commands

| Command | Behavior |
| --- | --- |
| `dal feedback validate <file>` | Validate schema, outcome semantics, and secret/PII policy without writing |
| `dal feedback ingest <file> [--store <dir>]` | Atomically publish an immutable local envelope after validation |
| `dal feedback query [filters]` | Query local records by ID, change, outcome, privacy tag, or date |
| `dal feedback summary [filters]` | Summarize outcomes and inefficiency categories |
| `dal capsule check <path-or-directory>` | Fail closed on capsule schema, freshness, source, or digest drift |
| `dal approval verify <file> ...` | Verify an exact human decision, scope, candidate digest, and expiry |
| `dal policy check <action-file> ...` | Record a deterministic policy decision; execute nothing |
| `dal eval run <suite-file> ...` | Run pinned local fixtures and publish a machine-readable scorecard |
| `dal run ingest <file> [--store <dir>]` | Validate and immutably store one run record with failure facts and pinned context |
| `dal cluster run [--store <dir>] [--output <dir>] [--batch <id>]` | Deterministically cluster failed runs by canonical failure fingerprint, bound to the run batch |
| `dal install user-global --approval <decision-file>` | Approval-verified automated install of the skill and global AGENTS.md |
| `dal seal init/verify/reveal` | One-shot sealed-holdout commitment with Merkle drift detection |
| `dal saga begin/complete/status/list` | Exactly-once effect intents and receipts for crash-resume |
| `dal admit issue/complete/status` | Nonce-bound admission: a candidate cannot forge its own boot receipt |
| `dal propose prepare/run` | Governed proposer: sanitized payload, verified send_data_externally approval, model draft on an editable surface |
| `dal branch record/evaluate/stats/select` | Bounded search archive: parent-linked branches, state/effect grader as value function, receipt-bound evidence, UCB1 selection |
| `dal verify run` | Confined verifier executor: Seatbelt-enforced local verification, fail-closed when the sandbox is unavailable |
| `dal verify run / propose run --runner docker` | Container-hosted harness execution: pinned image, workspace mount, network disabled (DAL-020) |
| `dal reset status\|execute` | Rebaseline: remove `.dal` evidence and start from the current snapshot; validated receipts under `.dal/resets/` |
| `dal optimize prepare\|evaluate` | SkillOpt-shaped prepare/evaluate-only adapter: sanitized training set from run records; deterministic bounded-edits validation gate (DAL-021) |
| `dal improvement transition <proposal-file> ... --output <new-file>` | Validate and exclusively publish one new immutable proposal state under `.dal/proposals/` |

Use `pnpm run dal --help` for exact options.

## Plugin modes (run / improvement)

The `plugins/` tree ships one dsh bundle (`@lunarmoon26/dal-modes`) with two separable modes:

- **Run mode** (`@lunarmoon26/dal-run-record`) — on by default: projects session events into privacy-safe run records under `.dal/runs` (counts, digests, outcome and failure codes; never prompt text, message content, tool arguments, or results).
- **Improvement mode** (`@lunarmoon26/dal-improve-tools`) — off by default: workbench tools over the deterministic dal CLI (cluster, prepare payload, summarize, branch evaluate, reset status). Nothing approval-gated — `propose run` and `reset execute` stay CLI-only.
- **G2 candidate** (`@lunarmoon26/dal-unknown-effect-guard`) — off by default: per-agent pre-execution lock for unknown workflow-effect retries. It is source/test evidence only, not an installed or applied generation.

Mounting the bundle into a profile (`dsh plugin --profile <name> add ./plugins/dal-modes ./plugins/dal-run-record ./plugins/dal-improve-tools`, then enable the tools row in the profile's `cordis.patch.yml`) is an approval-gated `install_or_mount_plugin` operation; see [`docs/spec.md`](docs/spec.md) DAL-019. The G2 package is deliberately excluded from that command: mounting it needs a new exact plugin decision, and applying it as a candidate needs a separate exact `apply_optimization_candidate` decision.

## Deliberate rejection examples

These commands return exit code `1` after reporting a safe rule/error code. The policy command still preserves its immutable rejection audit; sensitive feedback persists nothing.

```sh
pnpm run dal feedback validate tests/fixtures/feedback/secret.json
pnpm run dal policy check tests/fixtures/guardrail/unapproved-candidate.json --store .dal/demo-guardrail
pnpm run dal improvement transition tests/fixtures/proposals/proposed-hard-stop.json \
  --to sandbox_evaluated --actor-kind dsh-agent --actor-id agent-local \
  --evidence repo://.dal/evaluations/example.json --notes "Verify hard-stop enforcement." \
  --output .dal/proposals/hard-stop-attempt.json
```

## Operating model

- Exact persisted syntax: [`schemas/`](schemas/)
- Product behavior: [`docs/spec.md`](docs/spec.md)
- Guardrails, threat model, and scorecards: [`docs/evaluation-and-guardrails.md`](docs/evaluation-and-guardrails.md)
- Approval and privacy policy: [`docs/governance.md`](docs/governance.md)
- Operator procedures: [`docs/operator-guide.md`](docs/operator-guide.md)
- Requirement proof: [`docs/requirement-evidence.md`](docs/requirement-evidence.md)
- Future-only work: [`ROADMAP.md`](ROADMAP.md)

Local generated evidence lives under `.dal/` and is not source control. Hard-stop scorecards in the policy-configured evaluation store quarantine the matching digest; rollback and release remain manual human procedures.

## Install and first workspace

```sh
npm install -g @lunarmoon26/dal         # or: pnpm install -g . inside the checkout
dal init                             # inside any workspace: stores, skill, instructions, gitignore rules
```

`dal init` scaffolds `.dal/` evidence stores, an `end-task-feedback` skill, workspace instructions, and the evidence-store gitignore rules; it never overwrites existing files and never touches `~/.dsh` or `~/.agents`. For the workflow to appear in every workspace, a human performs the optional user-global step printed by `dal init` (skill under `~/.agents/skills/`, instructions under `~/.dsh/AGENTS.md`) — that step changes shared configuration and needs your approval. From then on agents log records as they work, and one human reconciles end-of-day (`dal feedback summary`, `dal cluster run`, proposals, human commits). See the operator guide for the runbook.

## Self-improvement boundary

Improvement proposals may change only the editable surfaces (`prompt`, `tool_descriptions`, `skills`, `memory_policy`, `routing`, `stop_retry_logic`, `harness_code`) and must carry a falsifiable prediction from the `proposed` stage. The immutable anchors (`evaluator`, `sealed_holdout`, `permissions`, `maximum_budget`, `promotion_policy`, `audit_log`, `rollback_mechanism`) are never proposal targets. Run records, deterministic failure clustering, and disabled source candidates feed the loop; model-based clustering and autonomous candidate application remain future work.

## How it is meant to be used

Agents work normally during the day; each task ends with a structured feedback record and, on failure, a run record. Those records live in VCS-tracked stores (`.dal/outbox`, `.dal/store`, `.dal/runs`, `.dal/clusters`). At the end of the day one human reconciles: pull, summarize, cluster failures, review, drive proposals through the staged lifecycle, and apply changes by committing them — dal itself applies nothing. See the operator guide for the exact runbook.

## Benchmark workspace

[`benchmarks/tau-style-workflow/`](benchmarks/tau-style-workflow/) is a target test workspace modeling the τ-bench pattern: closed-loop repetitive workflows, deterministic state/effect grading, written policy, and separate harness/business outcomes. Its approval-bound e2e path stages a minimal read-only candidate and separates candidate, journal-owning service, and grader containers so evaluator artifacts are not candidate-visible. `pnpm run benchmark:check` runs the offline suite and is part of `pnpm run check`; model batches still require exact external-transfer approval.
