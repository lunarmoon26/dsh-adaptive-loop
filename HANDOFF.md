# Handoff notes (2026-09-01)

## Current state

- Repository: `/Users/haochuanzhang/Workspace/dsh-adaptive-loop`, branch `main`.
- Change: `chg-benchmark-integrity-g2-20260831`.
- The worktree is intentionally dirty with the complete modified/untracked feature set; no commit was requested.
- Source implementation, focused tests, canonical docs, capsules, and the repository gate are complete.
- Final benchmark-image rebuild is blocked because the Dockerfile installs a local dsh plugin and no independent `install_or_mount_plugin` decision file exists.
- Required blocked feedback was validated and ingested at `.dal/store/fb-benchmark-integrity-g2-20260901.json` with digest `f138825219f80ae3778bd1ed24c09bf4b2b0021c74fb695c800ffb585b3b45b6`.
- A follow-up record for the hermetic hosted-CI fix supersedes it at `.dal/store/fb-benchmark-integrity-g2-ci-20260901.json` with digest `9e667c5e61f68110e20774bca792fe21dcd4c139b1a3743ee2aee54fd66b1e5c`.
- Do not fabricate a human approval or treat chat delegation, policy output, tests, or this handoff as authority.

## Implemented

- Harness and business outcomes are separate across run validation, clustering, optimizer episodes, proposer summaries, fixtures, and e2e records.
- `workflow-task.v1` owns evaluator-only goals and required/forbidden effect rules; grader `2.0.0` requires effect evidence for refusal success.
- The workflow service uses a checksummed append-only journal, serialized effects, fail-closed replay, atomic initialization, and file/parent-directory fsync.
- The e2e path uses candidate/service/grader containers with separate mounts/networks and authenticated grader snapshots.
- Approval manifests bind provider/model/generation, rollout count, fault profile, image/tools, projected/full task digests, policy, skill, prompts, rendered patch, and driver sources.
- Every attempt stages inputs, revalidates the approved manifest before the model boundary, runs containers by immutable image digest, and rejects staged-input drift.
- Receipts and summaries bind real run IDs, persisted run-record paths/digests, candidate/model/generation/image/manifest identities, state/journal/verdict digests, and isolation facts.
- Summary comparison rejects missing or reused evidence, derives metrics from receipt-bound outcomes, and rejects benchmark/context or model/candidate confounding.
- `--generation` accepts only `g0` and `g1`; G2 remains a disabled source-only guard with separate mount/application approvals.
- ADR 0003 permits only named purpose-specific executors and supersedes ADRs 0001/0002.

## Verification observed

- `CI=true pnpm run check`: pass.
- Unit suite: 31 files, 187 tests passed, 6 opt-in skips.
- Capsules: all valid; `capsule-dal-v0-contract` and `capsule-dsh-adapter-boundary` are `1.2.0`.
- Focused e2e/receipt/branch proof: 24 tests passed, one opt-in skip.
- Static and live three-container topology: pass.
- Existing-image deterministic grader: pass under `landlock-run`, full enforcement.
- Existing-image out-of-workspace write: denied as expected.
- Final scoped and full worktree reviews: no findings after including untracked additions.
- No model call, provider request, G2 mount/application, or optimization-candidate application occurred.

## Image blocker

Current documented image:

```text
dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2
sha256:df7173dfcf8edbd1c68623286a2451900b3f7e50f31f4ac33d2c737f28bf0ef3
```

It passed the live topology and Linux sandbox probes, but it predates the latest schema/types/e2e evidence changes and is not final provenance for this source tree.

The blocked Docker build would execute `npm install -g /opt/dal/plugins/dal-workflow-tools`. A later independent human decision must approve this exact scope:

```text
install dal-workflow-tools@0.1.0 source-sha256=a026f79e4dc063c0e2e583a2238fc5f10bcf6c854ded05f8e6c9ecc8934ae7e7 into isolated Docker image dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 via deploy/docker/Dockerfile; no shared host profile
```

Scope SHA-256: `85af710aa467e4a339020be249b522f509e5f95ada5ec201db08939209087d55`.

After receiving the decision file:

1. Verify it at the operation with `pnpm dal approval verify <decision-file> --action install_or_mount_plugin --scope '<exact-scope>'`.
2. Run `pnpm run build` and build both Docker tags from `deploy/docker/Dockerfile`.
3. Inspect and record the new immutable image ID in `deploy/docker/README.md`.
4. Rerun the live topology, deterministic grader, and denial probes.
5. Rerun `CI=true pnpm run check` if any source or canonical documentation changes.
6. Emit a new completed feedback record for the artifact-refresh follow-up; do not alter the blocked record for this session.

## Capsule pins

- `docs/spec.md`: `5b4bf8fba2d5e08ef088f17a8864df60a382f5fa31ee9ebe9335a6dd0582542d`
- `docs/governance.md`: `e07c31019a8f229364732a7ce19a4d49c756eb85406039852304a3388024e12a`
- `docs/evaluation-and-guardrails.md`: `43ff7a7e7e7ee53918aaa1a046e75219c6d8812090ec91f385a55d839c663c2f`
- `docs/architecture.md`: `f25a602c61b541fbb18fd78e81679f5903e75046e884410cecac8996db2495d7`
- `ROADMAP.md`: `89b26ea36756e19560c3e34d408b6e430f9dd96648500c0b9466f15f64d1aee1`

## Residual limits

- Candidate provider egress is not destination-allowlisted. Use a dedicated short-lived key; oracle isolation is not credential confinement.
- The Dockerfile parent remains the mutable `node:24-slim` tag; the previously resolved parent manifest was `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`.
- No full model batch was run, so there is no model-behavior or latest-batch quality claim.
