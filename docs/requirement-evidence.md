# Requirement Evidence

## Integrated Recorder and Staging Gate (2026-09-06)

Change: `chg-dal-recorder-staging-integration-20260906`.
Acceptance: preserve the approved recorder/controller and staging increments together with main's runtime attestation and HMR quarantine; synchronize reviewed source pins; pass focused regressions and the full repository gate; exclude raw transcripts, generated artifacts, and unrelated evaluator feedback from publication.

The normal merge integrates main through `b0e664a` without weakening controller qualification. The direct bridge test now supplies synthetic launcher-owned, session-bound evidence and a 1.1.0 policy. Missing evidence fails estimation; conflicting or transition-spanning bindings remain unbatched, with launcher pins preserved. Production recording still cannot trust the quarantined in-process HMR candidate state.

- Focused gate: 7 files passed, 79 tests passed, 1 opt-in test skipped.
- Full `pnpm run check`: typecheck and build passed; 34 files passed, 240 tests passed, 7 opt-in tests skipped; all 3 capsules validated; allowed-read policy passed; core and workflow benchmark scorecards passed without hard stops.
- Merge verification caught the legacy bridge fixture and the capsule test's pre-refresh fixed clock. The fixture now exercises attestation instead of bypassing it, and the fixed clock matches the reviewed refresh date; drift and expiry rejection remain tested.
- Capsules `dal-v0-contract` and `dsh-adapter-boundary` version 1.7.0 retain all merged semantic claims, update the reviewed spec/architecture/roadmap digests, and retain existing freshness deadlines and unaffected source identities.
- No model request, host profile change, installation, live HMR probe, image rebuild, or candidate activation was performed. The private evaluator repository was not changed.

Integration feedback: `.dal/store/fb-dal-recorder-staging-integration-20260906.json`. Earlier receipts below remain immutable historical evidence, not proof for this merged tree.

## DAL-021 staging integrity increment (2026-09-05)

### Closure after approved capsule refresh

The maintainer approved the roadmap delta and its source-pin refresh on
2026-09-05. Capsule `capsule-dsh-adapter-boundary` version `1.4.1` binds the
reviewed roadmap bytes; other source pins and freshness bounds are preserved.
The bounded staging increment is complete locally: `pnpm run check` passes
typecheck, build, 216 tests (six opt-in skips), all capsule checks, the policy
fixture, and both offline scorecards. This does not prove model execution or
activation and does not complete the broader evolution roadmap.

Completed feedback: `.dal/store/fb-dal-evolution-staging-integrity-complete-20260905.json`.
It supersedes the review receipt below without changing prior immutable records.

### Historical Review Fix: Verdict Output Conflict

Final state for `chg-dal-evolution-staging-integrity-20260905`: the adapter checks exclusive verdict publication before any candidate staging. The CLI delegates publication to that boundary. An existing verdict fails with `OPTIMIZE_OUTPUT_CONFLICT`, keeps its bytes unchanged, emits no successful evaluation output, and creates no candidate or staging directory. The regression covers both valid and rejected candidates. Subsequent staging errors may leave the newly published verdict; the focused contract documents this ordering.

- `pnpm exec vitest run tests/optimizer-adapter.test.ts tests/workflow.test.ts`: 33 tests passed (24 optimizer, 9 workflow).
- `pnpm run check`: typecheck and build passed; 215 tests passed, 6 opt-in skips, and the expected single capsule-integrity failure. Later chained verification stages did not run.
- `pnpm dal capsule check capsules/dsh-adapter-boundary.json`: the existing `/sources/2` roadmap digest mismatch remains; the dirty capsule was not changed.
- `git diff --check`: passed.

Superseding blocked feedback: `.dal/store/fb-dal-evolution-staging-integrity-review-20260905.json`, sourced from the matching `.dal/outbox/` file. It supersedes `fb-dal-evolution-staging-integrity-20260905`; the old outbox and immutable stored receipt remain unchanged. This follow-up changes only the CLI/adapter publication ordering, optimizer regression tests, focused contract/evidence, and its new feedback pair. No activation, external transfer, model call, commit, or unrelated implementation change was performed.

### Historical Initial Increment Evidence

Change: `chg-dal-evolution-staging-integrity-20260905`. At this stage, bounded implementation and focused tests passed; full closure was blocked on human-reviewed roadmap capsule refresh. These historical results are preserved; the closure above resolves that blocker.

| Requirement | Implementation / contract | Observed evidence |
| --- | --- | --- |
| Record the accepted full direction before code; distinguish future priorities | `ROADMAP.md`, `docs/optimizer-staging.md` | Roadmap updated before implementation; independent evaluator and complex controllers remain future scope |
| Bind candidate to exchange target/base and verify actual base bytes before reconstruction | `src/optimizer-adapter.ts` | Target/base/exchange mismatch, on-disk drift with surviving anchors, and lossy UTF-8 byte-drift regressions pass |
| Never return or stage rejected candidate text | Adapter gate and CLI delegation | Invalid surface, target, exchange, digest, no-change, and missing-anchor regressions pass |
| Confine exclusive raw-Markdown publication to direct `.dal/candidates/*.md` paths | `docs/optimizer-staging.md`, adapter staging block | Raw byte/digest roundtrip, file mode, existing-file preservation, live/outside/nested path denial, symlinked roots and existing/dangling symlink tests pass |
| Remove the overwrite-capable general writer | `src/json.ts`, CLI preparation, unique exchange path, workflow fixture callers | Prepare/evaluate CLI and workflow regressions pass; no optimizer schema fields changed |
| Run focused tests then the full gate | Local commands below | Focused pass; full gate blocked by the roadmap source digest in `capsules/dsh-adapter-boundary.json` |

Commands observed for this increment only:

- `pnpm exec vitest run tests/optimizer-adapter.test.ts`: final focused run passed 22 tests; the first run exposed four test-fixture path/base failures, corrected before the passing run.
- `pnpm exec vitest run tests/optimizer-adapter.test.ts tests/workflow.test.ts`: 31 tests passed after removal of the general writer.
- `pnpm run check`: typecheck and build passed; test phase had 213 passed, 6 opt-in skipped, and 1 failed capsule-integrity test. Later capsule/policy/scorecard commands in the chain did not run.
- `pnpm dal capsule check capsules/dsh-adapter-boundary.json`: failed closed on `/sources/2`, the changed `ROADMAP.md` digest. The existing dirty capsule was not refreshed or overwritten; a maintainer must review the accepted roadmap delta, refresh the pin, and rerun the full gate.
- `git diff --check`: passed.

Required blocked feedback: `.dal/outbox/fb-dal-evolution-staging-integrity-20260905.json`, ingested as `.dal/store/fb-dal-evolution-staging-integrity-20260905.json`. No model request, external transfer, installation, activation, commit, or push was performed. Recorder/controller changes and evaluator ownership remain untouched. This is local staging evidence, not protection from concurrent same-user directory replacement or a real cross-repository evaluation/deployment slice.

## Prior Increment Evidence

Status: Run-mode controller observation path, complete repository gate, and task feedback passed
Changes: `chg-control-supervisor-foundation-20260902`, `chg-run-controller-observation-path-20260902`
Evidence date: 2026-09-02

## Attestation and HMR Evidence

Status: HMR admission claim corrected and candidate application quarantined
Changes: `chg-control-supervisor-foundation-20260902`, `chg-runtime-generation-attestation-20260902`, `chg-hmr-adaptive-plugin-loop-20260904`, `chg-hmr-runtime-generation-stack-20260904`, `chg-hmr-readiness-admission-20260905`
Evidence date: 2026-09-05

This matrix maps canonical requirements to executable or inspectable evidence. “Pass” means the named evidence was observed in the current workspace; it does not imply model-backed benchmark quality or candidate promotion.

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
| DAL-019 run and improvement plugin modes | `plugins/dal-modes/`, `plugins/dal-run-record/`, `plugins/dal-improve-tools/`, `plugins/dal-hmr-candidate/` | Plugin-mode and HMR-candidate tests, including terminal enrollment and privacy assertions | Pass |
| DAL-020 container-hosted harness execution | `src/docker.ts`, `deploy/docker/`, Docker policy seams | `tests/docker.test.ts`; historical approved image build and live probes | Static pass; current image not refreshed |
| DAL-021 SkillOpt-shaped optimizer adapter | `src/optimizer-adapter.ts`, optimizer schemas | `tests/optimizer-adapter.test.ts` | Pass |
| DAL-022 benchmark measurement integrity | Workflow task/receipt/run schemas; grader/service/e2e driver; disabled G2 source | Grader, service, topology, receipt, summary, branch, clustering, and G2 tests | Pass |
| DAL-023 run-to-run controller observation | Controller policy/state schemas; `src/control/`; run-mode terminal bridge; CLI and evidence-store integration | `tests/controller.test.ts`, `tests/plugin-modes.test.ts`, init/reset/CLI tests | Pass |
| DAL-024 runtime generation attestation | Runtime manifest/evidence schemas; `src/runtime-generation.ts`; recorder binding; controller evidence gate | `tests/runtime-generation.test.ts`, controller/plugin/provenance tests | Pass; combined full gate passed 219 tests with 7 opt-in skips |
| DAL-025 quarantined HMR candidate staging | `plugins/dal-hmr-candidate/`, generation-aware `dal-run-record`, run-record schema/semantics | `tests/hmr-candidate.test.ts`, opt-in DSH readiness probe, `tests/plugin-modes.test.ts` | Pass; application/live publication removed, generation state runtime-private and always non-admitted, drift-safe rejection covered |

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
| The 2026-09-01 source baseline was rebuilt into the benchmark image and re-probed | Historical image identity plus live topology/Landlock/denial probes | Historical pass |

## DAL-023 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Controller state is separate from candidate proposal lifecycle | ADR 0004, focused contract, distinct schemas/store | Pass |
| One estimate uses an exact task set, batch, context, and pinned generation | `src/control/estimator.ts`, mixed-context/generation tests | Pass |
| Harness, business, and deterministic-check metrics have explicit denominators and exclusions | Controller policy/state schemas and fixture assertions | Pass |
| Estimates include versioned two-sided 95% Wilson intervals | `dal-wilson-score-v1`, estimator and tamper tests | Pass |
| Inadequate samples produce non-authorizing `insufficient_evidence` | Minimum-sample test | Pass |
| Complete snapshot identity and estimate time are deterministic; identical publication is idempotent | State tamper and retry tests | Pass |
| Existing persisted policy snapshots remain valid | Controller defaults stay outside `policy.v1`; guardrail CLI regression test | Pass |
| Command performs no proposer, model, network, sandbox, budget, transition, application, promotion, or rollback action | Static boundary review and command implementation | Pass |
| Explicit run-mode pins produce schema-valid terminal records consumable without fixture rewriting | Recorder-to-controller integration test and controller state assertions | Pass |
| Checkpoints, incomplete sessions, unsupported terminal reasons, non-canonical tools, and observed-context contradictions stay outside the configured batch | Recorder eligibility regression tests | Pass |
| Default recording stays unbatched and excludes raw prompt, message, argument, and result content | Existing recorder privacy test plus explicit null batch assertion | Pass |
| Summed token usage is represented by the run-record schema and persisted by the recorder | Run schema and recorder projection assertion | Pass |
| Controller-state evidence remains VCS-visible in initialized and repository workspaces | Init scaffold test and repository `.gitignore` consistency test | Pass |

## DAL-024 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Closed runtime manifest has deterministic RFC 8785 JCS identity and complete artifact references | Manifest schema/validator, digest fixture, malformed-I-JSON and closure tests | Pass |
| Appraisal is separate and distinguishes declared, observed, and verified assurance | Evidence schema/validator and required-claim tests | Pass |
| Session binding occurs only at creation and transition attempts remain visible after rollback | Recorder source contract, explicit checkpoint stage, monotonic sequence check, checkpoint/transition tests | Pass (synthetic service); production final-write availability is not proved because DSH disposal is not awaited |
| Existing harness identity remains independent | Run schema/type and recorder/controller assertions | Pass |
| Existing controller 1.0 policy/state snapshots remain valid without implicit attestation | Version-conditional schemas and legacy migration tests | Pass |
| Controller loads evidence and manifest through checked descriptors and fails closed on missing, unstable, downgraded, mixed, duplicate-session, unavailable, replayed, symlink-traversing, or forged identity | Controller estimator/store and focused negative tests | Pass |
| DSH emits authoritative effective config, resolver receipts, artifacts, and transition evidence | Upstream launcher/Loader integration | Not implemented; no runtime-proof claim |

## DAL-025 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Candidate paths are fixed at startup inside a real linked worktree and may not traverse links or reserved metadata | Coordinator path/worktree validation tests | Pass |
| Inactive staging stays separate from loaded source | Prepare/status assertions and source-no-write approval test | Pass |
| Candidate application cannot proceed, including with a staged digest or approval | `CANDIDATE_ADMISSION_QUARANTINED` unit test; unchanged live-file assertion | Pass |
| `hmr/reload` proves replacement Fiber readiness | Exact DSH source trace plus opt-in failed-start probe | Fail upstream; admission quarantined |
| Event-time disk digest identifies the imported multi-file closure | Exact DSH source trace plus opt-in hybrid-closure probe | Fail upstream; admission quarantined |
| Evaluation uses an authenticated ready candidate generation | Authoritative DSH producer and evaluator Phase 3 probe | Not implemented; no candidate-eligibility claim |
| No DSH core patch, live candidate write, or automated promotion occurs | Code-owned quarantine; disabled bundle row; operator contract | Pass |

## Observed commands

```text
CI=true pnpm run typecheck
CI=true pnpm exec vitest run tests/plugin-modes.test.ts tests/init.test.ts
CI=true pnpm exec vitest run tests/controller.test.ts tests/init.test.ts tests/reset.test.ts tests/cli.test.ts
CI=true pnpm exec vitest run tests/runtime-generation.test.ts tests/controller.test.ts tests/plugin-modes.test.ts tests/e2e-provenance.test.ts
CI=true pnpm exec vitest run tests/e2e-summary.test.ts tests/e2e-topology.test.ts tests/execution-receipt.test.ts tests/branch.test.ts
pnpm dal capsule check capsules/dal-v0-contract.json
pnpm dal capsule check capsules/dsh-adapter-boundary.json
CI=true pnpm run check
DAL_DSH_HMR_CHECKOUT=<pinned-local-checkout> pnpm exec vitest run tests/hmr-candidate.test.ts tests/plugin-modes.test.ts tests/clustering.test.ts
pnpm dal approval verify .dal/outbox/dec-dal-workflow-tools-image-20260901.json --action install_or_mount_plugin --scope <exact-isolated-image-scope>
docker build -f deploy/docker/Dockerfile -t dsh-adaptive-loop/dsh:0.1.1-rc.2 -t dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 .
CI=true DAL_E2E_TOPOLOGY_PROBE=1 pnpm exec vitest run tests/e2e-topology.test.ts
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <deterministic-grader-command>
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <out-of-workspace-denial-command>
```

Historical pre-attestation recorder source-gate result: typecheck and build passed; 32 test files passed with 197 tests and 6 opt-in skips; all capsules validated; policy, core evaluation, and benchmark scorecards passed with no hard stop. The focused run-mode bridge proof passed 18 tests across recorder and initialization coverage. New controller estimates additionally require DAL-024 attestation.

Historical HMR source-gate result: typecheck and build passed; 33 test files passed with 199 tests and 7 opt-in skips; all capsules validated; policy, core evaluation, and benchmark scorecards passed with no hard stop. That result did not await replacement Fibers or test multi-file imported-closure identity and is not current admission evidence.

Historical HMR-loop focused result: 23 tests passed with 5 unrelated skips across the coordinator, run recorder, bundle, schema, and clustering suites; typecheck passed. The opt-in real composition case loaded `@deepseek-ai/cordis-plugin-hmr` 1.0.17, Loader 1.0.3, and Timer 1.1.4 from local DSH identity `b6589bc9f3896ce742c1d53c03c32e04b542e735`, observed one reload and a later baseline reload. It did not prove readiness at the event or the runtime's imported closure. The executed built-artifact SHA-256 digests were HMR `822672a70baa81b95bd437275bfdcf6235702f960e03f8c4418588255bc2a880`, Loader `68722da3bd09e32e23165a83de3728b3cb9fef118153912028af980dfaabc7d2`, and Timer `aab5832ebcefccd223b16ff3e8f09ca611841f53352c8439ea3acf7cc11ad002`; no profile or DSH source was changed.

Required HMR-loop task feedback validated and ingested at `.dal/store/fb-hmr-adaptive-plugin-loop-20260904.json`; feedback digest `875e22dbbcc4778a227c726d95f49f3aeb8c6a20a5f745b7add65498b0182e3c`.

Historical combined-stack post-review result: the runtime-generation/HMR integration suites passed 55 tests with 1 opt-in skip; the real pinned Loader/HMR composition run passed all 38 selected tests; and the complete repository gate passed typecheck, build, 34 test files with 219 tests and 7 opt-in skips, all capsules, policy, core evaluation, and benchmark evaluation with no hard stop. Those checks exercised the superseded admission design. They did not prove replacement-Fiber readiness or imported multi-file closure identity and are not current admission evidence.

Required combined-stack task feedback validated and ingested at `.dal/store/fb-hmr-runtime-generation-stack-20260904.json`; feedback digest `74fbd036c9899a76ddd914279666d193dd9b72dc21827ead525b2beabfa2feb3`.

The final security-review record superseded that preliminary combined-stack record at `.dal/store/fb-hmr-runtime-generation-stack-review-20260904.json`; feedback digest `77d13779e852bceb02180ba5dd770aa3c0b6f4319305f31dcbdf74cce6c5590b`.

After PR #5's content-equivalent squash merge, the three HMR-only commits were rebased onto merged `main`. The pre- and post-rebase feature trees matched, two-dot and three-dot comparisons agreed on the same 37-file HMR surface, and the complete repository gate again passed 219 tests with 7 opt-in skips. The merged-base feedback superseded the pre-main-rebase record at `.dal/store/fb-hmr-main-rebase-20260904.json`; feedback digest `3f80228f79419ed70bc06844661036e4fafdab58f3e360ed3d86fe4f2e97f80e`.

Current quarantine correction result: three focused suites passed 27 tests with 6 opt-in skips; the opt-in real-DSH coordinator suite passed all 6 tests, including failed-start and hybrid-closure probes; and the complete repository gate passed typecheck, build, 34 test files with 214 tests and 7 opt-in skips, all capsules, policy, core evaluation, and benchmark evaluation with no hard stop. Final focused review reported no findings. The correction removes live publication and approval execution, makes generation state runtime-private and non-overridable, and prevents the production recorder from trusting mutable in-process candidate state.

Required correction feedback validated and ingested at `.dal/store/fb-hmr-readiness-admission-20260905.json`; feedback digest `630b637e5f6f01a68b108493e2019a75e99f6f42a3ed675b124a76f3ee8ea49e`.

The pre-reset feedback records named in earlier revisions were intentionally removed by the approved rebaseline; their provenance remains in git history and `.dal/resets/reset-23690aca-134b-415f-8e4a-562ed65bdd6c.json`. Current feedback is stored at `.dal/store/fb-run-controller-observation-path-20260902.json` with digest `9125c3ed2fa15dc339e08ecb839ba409905fb1653936c1a4a4003c3926180c84`.

Historical latest-image result for the 2026-09-01 baseline: image `sha256:1adcf95dedf922eaf182fefee0d4ddcaf90fed00eaa2eb947bfe99f7f97f64d9` was rebuilt after exact approval verification. The live three-container service/grader topology passed; the deterministic grader passed under `landlock-run` with full enforcement; an attempted `/root` write was denied. This is not current-image proof for the present source tree.

## Historical artifact refresh

The Dockerfile installs `dal-workflow-tools@0.1.0` globally into the isolated image. The user explicitly approved the previously stated exact scope, recorded as `dec-dal-workflow-tools-image-20260901`; `pnpm dal approval verify` passed immediately before the Docker build. The decision authorized only the local isolated image and did not authorize a shared host profile, G2 mounting, optimization-candidate application, or external data transfer.

Approved scope:

```text
install dal-workflow-tools@0.1.0 source-sha256=a026f79e4dc063c0e2e583a2238fc5f10bcf6c854ded05f8e6c9ecc8934ae7e7 into isolated Docker image dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 via deploy/docker/Dockerfile; no shared host profile
```

Scope SHA-256: `85af710aa467e4a339020be249b522f509e5f95ada5ec201db08939209087d55`.

Resolved parent manifest: `node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`. The Dockerfile still names the mutable tag; pin the digest in source before distributing the image.

## Explicit non-evidence

- No model-backed benchmark batch or provider request was run.
- The benchmark image was not rebuilt for the current source tree.
- No G2 plugin or DAL workbench plugin was installed or mounted into a DSH profile, and no repository/production optimization candidate was applied. Candidate writes occurred only in disposable test worktrees.
- Generic run ingestion validates `candidate_generation` consistency but does not independently authenticate an HMR admission receipt or grant application/promotion authority.
- Candidate provider egress remains not destination-allowlisted; topology proof is not credential-egress confinement.
- The latest-image probes do not establish model compliance or a general OS-sandbox guarantee beyond the exercised Linux container.
