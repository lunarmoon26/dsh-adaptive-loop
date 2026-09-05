# 0003: Permit only purpose-specific approved executors

Status: Accepted; candidate-applier boundary revised by [`0007-quarantine-hmr-candidate-admission.md`](0007-quarantine-hmr-candidate-admission.md), which supersedes ADR 0006
Date: 2026-08-31
Related: [`../spec.md`](../spec.md), [`../architecture.md`](../architecture.md), [`../governance.md`](../governance.md)

## Context

The local immutable and deterministic v0 core remains the default, but useful deployment and benchmark flows now need a few real operations: confined verification, fixed user-global installation, sanitized proposal generation, and isolated model-backed benchmark attempts. A blanket “no executor” rule no longer describes the system. A generic shell, network, configuration, plugin, optimizer, or candidate-application executor would still collapse the authority boundary and create unnecessary blast radius.

## Decision drivers

- Preserve local, credential-free validation and evaluation as the default path.
- Keep policy decisions, evaluation scores, and repository text unable to grant authority.
- Verify confinement or exact human approval at the operation that creates the side effect.
- Minimize each executor's data, filesystem, environment, and configuration surface.
- Keep plugin mounting, optimizer execution, and candidate application unavailable.

## Options considered

### Keep every executor outside v0

- Helps by retaining the smallest trust boundary.
- Hurts because approved deployment, proposal, and isolated benchmark workflows cannot be exercised end to end.

### Add a generic approved action executor

- Helps by centralizing execution plumbing.
- Hurts because one abstraction would combine unrelated shell, network, configuration, plugin, and application authority.

### Add only operation-owned executors

- Helps because each operation can minimize inputs and independently verify its exact approval or confinement contract.
- Hurts because enforcement is duplicated at several boundaries and every new executor requires separate architecture review.

## Decision

Retain deterministic policy and human authority, but permit only named, purpose-specific executors. The confined verifier rechecks policy and sandbox availability; user-global install writes only fixed governed assets after exact `change_shared_harness_config` approval; proposer and benchmark e2e transfer only digest-bound projections after exact `send_data_externally` approval. Policy checks remain non-executing. No generic executor, plugin installer or mounter, optimizer runner, or candidate applier ships.

The benchmark e2e executor additionally uses a Docker candidate/service/grader topology: the candidate sees a minimal read-only projection and typed service API, the service alone owns the checksummed journal, and the grader alone receives evaluator artifacts and an authenticated snapshot.

## Consequences

- Positive: ordinary validation, tests, capsules, clustering, and scorecards remain local and credential-free.
- Positive: each real side effect has a narrow, testable authority and isolation boundary.
- Positive: an approval for one operation cannot imply plugin deployment or candidate application.
- Negative: manifests, receipts, and operation-specific tests must remain synchronized with every executor change.
- Negative: the benchmark topology proves only the exercised container boundary, not model compliance or general sandbox security.

## Confirmation

- Exact-action/scope/digest/expiry tests cover the fixed installer, proposer, and e2e manifest boundaries.
- Docker topology tests assert that candidate arguments expose no repository, journal, evaluator token, full task, or grader mount.
- Execution receipts bind image, composition, staged workspace, journal, state, verdict, and isolation identities.
- The repository gate runs without credentials or external requests.

## Links

- Supersedes [`0001-local-staged-improvement.md`](0001-local-staged-improvement.md).
- Supersedes [`0002-deterministic-guardrails-before-evaluation.md`](0002-deterministic-guardrails-before-evaluation.md).
