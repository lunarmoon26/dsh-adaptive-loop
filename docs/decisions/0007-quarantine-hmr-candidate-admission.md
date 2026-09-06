# 0007: Quarantine HMR candidate admission

Status: Accepted
Date: 2026-09-05
Change: `chg-hmr-readiness-admission-20260905`
Supersedes: [`0006-stage-approved-candidates-through-hmr.md`](0006-stage-approved-candidates-through-hmr.md)
Related: [`../spec.md`](../spec.md), [`../architecture.md`](../architecture.md), [`../governance.md`](../governance.md)

## Context

ADR 0006 treated DSH's public `hmr/reload` event as proof that a replacement
plugin had activated successfully. Source inspection at DSH commit
`d347e703908d0406b7a7ef80e3a0e594d86b2215` shows a different boundary: module
HMR registers replacement Fibers and emits `hmr/reload` without awaiting those
Fibers. Cordis starts a Fiber after a microtask and contains startup failure in
the Fiber's `failed` state. Module HMR therefore neither reports readiness nor
restores the prior runtime after a later Fiber startup failure.

The coordinator also publishes a multi-file candidate through separate atomic
renames. A reload started after an early dependency write can import a hybrid
closure. By the time `hmr/reload` is emitted, every source file can already
contain the approved candidate, so a post-event disk digest does not identify
the bytes the runtime imported.

Executable probes against DSH commit
`b6589bc9f3896ce742c1d53c03c32e04b542e735` reproduced both cases. Its relevant
Cordis Registry, Fiber, and Timer sources are identical to the inspected commit;
the HMR difference only wraps partial reload in a transition mutation.

## Decision drivers

- Never represent disk bytes as an activated runtime generation without an
  authoritative imported-artifact receipt.
- Never admit a candidate before every replacement Fiber reaches readiness.
- Keep the already disabled source safe even if an operator mounts it directly.
- Preserve inactive staging while the evaluator establishes the missing DSH
  lifecycle contract.

## Decision

`@lunarmoon26/dal-hmr-candidate` remains disabled in the bundle, and
`dal_candidate_apply` now fails closed with
`CANDIDATE_ADMISSION_QUARANTINED` before approval verification or any live-file
write. `dal_candidate_prepare` and `dal_candidate_status` remain available for
inactive authoring and digest inspection. No current coordinator state can be
`admitted`, and no run can become candidate-evaluation-eligible through this
package.

The private evaluator owns the next evidence increment: a version-pinned,
read-only lifecycle probe correlating HMR events, Loader entries, Fiber instance
states, imported generation identity, disposal, and session binding. Admission
may be reconsidered only after one immutable candidate closure, awaited
readiness, failed-start rollback, durable transition recovery, and real DSH
integration tests all exist.

Production promotion remains a separate human decision and deployment action.
HMR observation can support diagnostics but is not promotion or deployment
authority.

## Consequences

- Positive: mounting the source cannot publish or admit candidate bytes.
- Positive: staging remains usable while Phase 3 gathers trustworthy lifecycle
  evidence.
- Negative: temporary in-process plugin candidate evaluation is unavailable.
- Negative: previous successful-path tests become historical evidence, not
  current acceptance proof.
- Residual: external edits can still trigger DSH HMR; DAL does not claim an
  identity or readiness result for those reloads.

## Confirmation

- Unit tests require the quarantine error and unchanged live files even when a
  staged candidate exists.
- Opt-in DSH integration tests reproduce pre-readiness `hmr/reload`, failed
  startup without runtime rollback, and the multi-file hybrid closure race.
- Documentation and requirement evidence mark HMR admission unavailable rather
  than successful.
