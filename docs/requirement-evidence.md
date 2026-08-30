# Requirement Evidence

Status: Repository-wide gate passed; required task feedback validated and ingested
Change: `chg-rdl-v0-self-improvement-loop-core`
Evidence date: 2026-08-28

This matrix maps canonical requirements to executable or inspectable evidence. “Pass” means the named evidence was observed in the current workspace; it does not claim dsh, OS-sandbox, model, optimizer, or external-service integration.

## Requirements

| Requirement | Implementation owner | Evidence | Current result |
| --- | --- | --- | --- |
| DAL-001 structured feedback | `schemas/feedback-log.v1.schema.json`, `src/feedback.ts` | `tests/feedback.test.ts`, completed/blocked/aborted/invalid/secret fixtures | Pass |
| DAL-002 required task workflow | `AGENTS.md`, `.agents/skills/end-task-feedback/SKILL.md` | `.dal/store/fb-rdl-v0-evaluation-guardrails-20260827.json`; digest `b2d90a699197c8ac0cf91f25f14371fd780a7778a8e1f70beedb3872a372b164` | Pass |
| DAL-003 immutable local aggregation | `schemas/stored-feedback-record.v1.schema.json`, `src/store.ts` | `tests/store.test.ts` | Pass |
| DAL-004 staged human lifecycle | `schemas/improvement-proposal.v1.schema.json`, `src/improvement.ts` | `tests/workflow.test.ts`, hard-stop proposal fixture | Pass |
| DAL-005 disabled optimizer boundary | `schemas/optimizer-exchange.v1.schema.json`, `src/optimizer.ts` | `tests/workflow.test.ts` | Pass |
| DAL-006 source-bound capsules | `schemas/knowledge-capsule.v1.schema.json`, `src/capsule.ts`, `capsules/` | `tests/capsule.test.ts`, `dal capsule check capsules` | Pass |
| DAL-007 developer commands | `src/cli.ts`, `README.md`, `docs/operator-guide.md` | `tests/cli.test.ts`, README success/rejection smoke commands | Pass |
| DAL-008 exact human approval | `schemas/approval-decision.v1.schema.json`, `src/approval.ts` | `tests/workflow.test.ts`, candidate approval fixture | Pass |
| DAL-009 guardrails and evaluation | guardrail/evaluation schemas, `src/guardrail.ts`, `src/evaluation.ts` | `tests/guardrail.test.ts`, `tests/evaluation.test.ts`, `v0-suite.json` | Pass |
| DAL-010 self-improvement loop core | `schemas/run-record.v1.schema.json`, `schemas/cluster-record.v1.schema.json`, `src/runs.ts`, `src/clustering.ts`, proposal surface/prediction rules | `tests/clustering.test.ts`, `tests/workflow.test.ts` anchor/prediction cases, run fixtures | Pass |
| DAL-018 evidence reset and rebaseline | `schemas/reset-receipt.v1.schema.json`, `src/reset.ts`, `.dal/resets/` receipts | `tests/reset.test.ts` | Pass |
| DAL-019 run and improvement plugin modes | `plugins/dal-modes/` bundle, `plugins/dal-run-record/`, `plugins/dal-improve-tools/` | `tests/plugin-modes.test.ts` | Pass |
| DAL-020 container-hosted harness execution | `src/docker.ts`, `deploy/docker/`, executor/propose `--runner docker` seams, policy docker fields | `tests/docker.test.ts`, in-container probe (`deploy/docker/README.md`) | Pass |
| DAL-021 SkillOpt-shaped optimizer adapter | `src/optimizer-adapter.ts`, `schemas/optimizer-{training-set,candidate,verdict}.v1.schema.json`, `dal optimize prepare\|evaluate` | `tests/optimizer-adapter.test.ts` | Pass |

## Acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Completed, blocked, and aborted paths validate | `tests/feedback.test.ts`; three committed fixtures | Pass |
| Invalid completion is rejected | `invalid-completed.json`; feedback semantic test | Pass |
| Secret/PII input persists nothing | privacy/store tests; synthetic secret/PII fixtures | Pass |
| Immutable ingestion and retry/conflict behavior | `tests/store.test.ts` | Pass |
| Query and summary behavior | `tests/store.test.ts` | Pass |
| Capsule freshness/source drift fails | `tests/capsule.test.ts`; full capsule gate | Pass |
| Wrong approval action/scope/status/digest/time fails | `tests/workflow.test.ts` | Pass |
| Human-only transition rejects agent actor | `tests/workflow.test.ts` | Pass |
| README commands run locally as documented | success and deliberate rejection smoke | Pass |
| Allowed local request is audited without execution | `tests/guardrail.test.ts`; `tests/cli.test.ts` | Pass |
| Secret/PII rule output excludes matched values | privacy and CLI tests | Pass |
| Unapproved candidate is rejected and target unchanged | `tests/guardrail.test.ts` | Pass |
| Suite classes, metrics, and dangerous-action hard stops | `tests/evaluation.test.ts`; `v0-suite.json` | Pass |
| Hard-stop proposal cannot progress | `tests/workflow.test.ts` | Pass |
| No model/network/optimizer/executor dependency ships | production dependency tree and source import inspection | Pass |
| Immutable-anchor proposal surface is rejected at every stage | `tests/workflow.test.ts` anchor case | Pass |
| Falsifiable prediction is required from `proposed` and forbidden before it | `tests/workflow.test.ts` prediction cases | Pass |
| Run records ingest immutably with idempotent retry and conflict failure | `tests/clustering.test.ts` | Pass |
| Failed runs cluster by canonical fingerprint; successes are skipped; cluster records are immutable and idempotent | `tests/clustering.test.ts` | Pass |
| Clustering runs no model/classifier and fails closed on a bad store | `tests/clustering.test.ts`; dependency/source inspection | Pass |

## Observed commands

```text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec vitest run tests/clustering.test.ts tests/workflow.test.ts tests/cli.test.ts
pnpm run check
pnpm run dal run ingest tests/fixtures/runs/run-fixture-test-failure-1.json --store .dal/demo-runs
pnpm run dal cluster run --store .dal/demo-runs --output .dal/demo-clusters --format json
pnpm run dal feedback validate .dal/outbox/fb-rdl-v0-self-improvement-loop-core-20260828.json
pnpm run dal feedback ingest .dal/outbox/fb-rdl-v0-self-improvement-loop-core-20260828.json
pnpm run dal feedback query --feedback fb-rdl-v0-self-improvement-loop-core-20260828 --format json
```

Observed final results: TypeScript and build passed; eight test files passed with 55 tests; both capsules validated against current sources; the allowed local policy request was audited; the offline suite emitted a passing scorecard with all five minimum rates at `1`, both maximum rates at `0`, zero external requests/cost, and `continue` disposition; run ingestion stored and re-ingested idempotently; deterministic clustering grouped same-signature failures, skipped successful runs, and re-clustered idempotently; immutable-anchor proposals and missing/early predictions were rejected. The required completed feedback record passed secret/PII validation, was ingested immutably, and was queryable by ID.

The local production dependency tree contains AJV and AJV Formats, the pinned dsh sandbox seam packages (`@deepseek-ai/dsh-sandbox` and `dsh-sandbox-local` `0.1.1-rc.2` on Cordis `4.0.1`) for confined verifier execution, and their transitive utilities. Static runtime import inspection found no network client, model SDK, optimizer runtime, plugin installer, shared-configuration writer, or candidate-application executor; the only child-process spawns are the approval-bound proposer session and the confined verifier.

## Explicit non-evidence

- No dsh/Cordis plugin was installed, mounted, or executed.
- No OS sandbox, network denial mechanism, external provider, model judge, GEPA, or SkillOpt runtime was executed.
- No candidate, plugin, skill, capsule, or shared harness configuration was applied.
- BX was unavailable for the guardrail option-research slice; direct pinned primary sources were reviewed instead.
- No registry-backed online vulnerability query was run during local closure.
