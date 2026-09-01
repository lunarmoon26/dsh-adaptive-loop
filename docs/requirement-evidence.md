# Requirement Evidence

Status: Repository gate passed; blocked feedback validated/ingested; final benchmark-image rebuild awaits independent human approval
Change: `chg-benchmark-integrity-g2-20260831`
Evidence date: 2026-09-01

This matrix maps canonical requirements to executable or inspectable evidence. “Pass” means the named evidence was observed in the current workspace. A blocked artifact refresh does not invalidate the passing source gate, but it prevents claiming that the current source was rebuilt into the documented image.

## Requirements

| Requirement | Implementation owner | Evidence | Current result |
| --- | --- | --- | --- |
| DAL-001 structured feedback | `schemas/feedback-log.v1.schema.json`, `src/feedback.ts` | `tests/feedback.test.ts` | Pass |
| DAL-002 required task workflow | `AGENTS.md`, `.agents/skills/end-task-feedback/SKILL.md` | Feedback validation/ingestion workflow | Pass |
| DAL-003 immutable local aggregation | `schemas/stored-feedback-record.v1.schema.json`, `src/store.ts` | `tests/store.test.ts` | Pass |
| DAL-004 staged human lifecycle | `schemas/improvement-proposal.v1.schema.json`, `src/improvement.ts` | `tests/workflow.test.ts` | Pass |
| DAL-005 disabled optimizer boundary | `schemas/optimizer-exchange.v1.schema.json`, `src/optimizer.ts` | `tests/workflow.test.ts` | Pass |
| DAL-006 source-bound capsules | `schemas/knowledge-capsule.v1.schema.json`, `src/capsule.ts`, `capsules/` | `tests/capsule.test.ts`, `dal capsule check capsules` | Pass |
| DAL-007 developer commands | `src/cli.ts`, `README.md`, `docs/operator-guide.md` | `tests/cli.test.ts` | Pass |
| DAL-008 exact human approval | `schemas/approval-decision.v1.schema.json`, `src/approval.ts` | `tests/workflow.test.ts` | Pass |
| DAL-009 guardrails and evaluation | Guardrail/evaluation schemas, `src/guardrail.ts`, `src/evaluation.ts` | `tests/guardrail.test.ts`, `tests/evaluation.test.ts`, `v0-suite.json` | Pass |
| DAL-010 self-improvement loop core | Run/cluster schemas, `src/runs.ts`, `src/clustering.ts`, proposal rules | Clustering, workflow, and run fixtures | Pass |
| DAL-018 evidence reset and rebaseline | Reset schema, `src/reset.ts`, `.dal/resets/` receipts | `tests/reset.test.ts` | Pass |
| DAL-019 run and improvement plugin modes | `plugins/dal-modes/`, `plugins/dal-run-record/`, `plugins/dal-improve-tools/` | `tests/plugin-modes.test.ts` | Pass |
| DAL-020 container-hosted harness execution | `src/docker.ts`, `deploy/docker/`, Docker policy seams | `tests/docker.test.ts`; live Landlock and denial probes | Pass for existing image; rebuild blocked |
| DAL-021 SkillOpt-shaped optimizer adapter | `src/optimizer-adapter.ts`, optimizer schemas | `tests/optimizer-adapter.test.ts` | Pass |
| DAL-022 benchmark measurement integrity | Workflow task/receipt/run schemas; grader/service/e2e driver; disabled G2 source | Grader, service, topology, receipt, summary, branch, clustering, and G2 tests | Pass |

## DAL-022 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Harness completion remains separate from the deterministic business verdict | Run schema/semantics, fixtures, clustering and optimizer tests | Pass |
| Failed business outcomes name a failed deterministic check | Run schema condition and semantic validation | Pass |
| Refusal success requires evaluator-owned effect evidence | `workflow-task.v1`, grader `2.0.0`, refusal fixtures/tests | Pass |
| Journal replay is checksummed, serialized, crash-safe, and fail-closed | Workflow service source and HTTP/tool tests | Pass |
| Candidate, service, and grader use distinct mounts and networks | `e2e-topology.ts`; static and live topology tests | Pass |
| Approval manifest binds full evaluator inputs, rendered patch, driver source, rollout count, and image | `run-e2e.ts`; topology/manifest tests | Pass |
| Every attempt revalidates staged inputs before the model boundary | Manifest-drift and staged-input checks | Pass |
| Receipts bind task, run, candidate, model, generation, image, manifest, state, journal, verdict, and isolation | Receipt schema plus e2e summary regression tests | Pass |
| Summaries bind persisted run records, reject reused evidence, and recompute metrics | `e2e-summary.ts`, 13 focused summary tests | Pass |
| Frozen-context comparison rejects benchmark drift and model/candidate confounding | Summary comparison tests | Pass |
| Arbitrary or G2 execution labels cannot claim an ordinary run | Driver and summary validation tests | Pass |
| G2 unknown-effect guard remains source-only and retains same-key locks until terminal evidence | Disabled bundle row and G2 unit tests | Pass |
| Current source is rebuilt into the benchmark image and re-probed | Exact `install_or_mount_plugin` decision required by the Dockerfile’s local plugin installation | Blocked |

## Observed commands

```text
CI=true pnpm run typecheck
CI=true pnpm exec vitest run tests/e2e-summary.test.ts tests/e2e-topology.test.ts tests/execution-receipt.test.ts tests/branch.test.ts
pnpm dal capsule check capsules/dal-v0-contract.json
pnpm dal capsule check capsules/dsh-adapter-boundary.json
CI=true pnpm run check
CI=true DAL_E2E_TOPOLOGY_PROBE=1 pnpm exec vitest run tests/e2e-topology.test.ts
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <deterministic-grader-command>
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <out-of-workspace-denial-command>
```

Observed source-gate result: typecheck and build passed; 31 test files passed with 187 tests and 6 opt-in skips; all capsules validated; policy, core evaluation, and benchmark scorecards passed with no hard stop. Focused e2e integrity proof passed 24 tests with one opt-in skip, and final scoped/full diff reviews reported no findings.

Required task feedback validated and ingested at `.dal/store/fb-benchmark-integrity-g2-20260901.json`; feedback digest `f138825219f80ae3778bd1ed24c09bf4b2b0021c74fb695c800ffb585b3b45b6`. The clean-CI portability follow-up supersedes it at `.dal/store/fb-benchmark-integrity-g2-ci-20260901.json`; digest `9e667c5e61f68110e20774bca792fe21dcd4c139b1a3743ee2aee54fd66b1e5c`.

Observed existing-image result: the live three-container service/grader topology passed; the deterministic grader passed under `landlock-run` with full enforcement; an attempted `/root` write was denied. These probes exercised the previously built image `sha256:df7173dfcf8edbd1c68623286a2451900b3f7e50f31f4ac33d2c737f28bf0ef3`, not a rebuild of the latest source.

## Blocked artifact refresh

The Dockerfile installs `dal-workflow-tools@0.1.0` globally into the isolated image. Project governance requires an independent, exact, unexpired `install_or_mount_plugin` decision at that operation. No such decision file was supplied, and an agent-authored “human” decision would falsify the authority record. The source gate and existing-image probes therefore completed, but no image rebuild or new image digest is claimed.

Required scope for a later human decision:

```text
install dal-workflow-tools@0.1.0 source-sha256=a026f79e4dc063c0e2e583a2238fc5f10bcf6c854ded05f8e6c9ecc8934ae7e7 into isolated Docker image dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 via deploy/docker/Dockerfile; no shared host profile
```

Scope SHA-256: `85af710aa467e4a339020be249b522f509e5f95ada5ec201db08939209087d55`.

## Explicit non-evidence

- No model-backed benchmark batch or provider request was run.
- No G2 plugin was installed, mounted, or applied, and no optimization candidate was applied.
- No new benchmark image was built from the latest source.
- Candidate provider egress remains not destination-allowlisted; topology proof is not credential-egress confinement.
- The existing-image probes do not establish model compliance, a general OS-sandbox guarantee, or latest-image provenance.
