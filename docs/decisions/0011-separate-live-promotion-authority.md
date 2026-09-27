# 0011: Separate live promotion authority from the evolution harness

Status: Accepted
Date: 2026-09-27
Change: `chg-dal-hitl-promotion-control-20260927`
Related: [`../live-text-loop.md`](../live-text-loop.md),
[`../live-promotion-control.md`](../live-promotion-control.md),
[`../workspace-autonomy.md`](../workspace-autonomy.md), [`../spec.md`](../spec.md)

## Context

The outer agent is the task and effect execution harness. DSH plus DAL is an
inner evolution harness that observes safe evidence, generates bounded text
candidates and evaluates them. Treating that nesting as promotion authority
would let the system under evaluation change the generation consumed by future
outer-agent work.

The existing live text loop content-addresses prompt generations, has an atomic
active pointer, retains the incumbent and can compensate a failed canary. Its
original campaign grant also allowed automatic local activation. That is too
wide for the selected human-in-the-loop operating model. Current DSH
`approval/request` is a per-session tool-approval waterfall, not a durable
candidate-promotion authority. Current HMR lacks imported-closure identity,
awaited readiness and failed-start rollback, so it remains quarantined.

## Decision drivers

- The outer execution harness must consume one immutable generation at a task or
  session boundary without acquiring evolution or deployment authority.
- Candidate, evaluator, policy, approval, active pointer and rollback evidence
  must remain independently reviewable.
- Rejection must be auditable without mutating the active generation.
- A reviewer needs a local comparison interface without turning a dashboard
  click or Cordis plugin into authority.
- The first vertical slice remains workspace-local prompt/skill text; executable
  plugin mutation needs separate isolation and runtime evidence.

## Decision

DAL search now stages a strictly eligible live text candidate in
`awaiting_review`; it does not activate it. A review request binds the frozen
plan, current incumbent, exact candidate, deterministic evaluation and
pre-review state. A human supplies the existing exact, expiring
`approval-decision.v1` record for `apply_optimization_candidate`. The record is
human-attested JSON, not a cryptographic signature or external identity proof.

Only the named DAL promotion executor verifies that approval immediately before
the atomic pointer switch. It records a durable decision receipt, runs the
fixed post-switch canary and retains the candidate only if that canary passes.
Canary failure compensates to the exact incumbent without sending a new request.
A human rejection creates a terminal review record and leaves the incumbent
active. Ambiguous operations stay non-retryable.

The first dashboard is a loopback-only DAL process. It renders a local review
projection, candidate/incumbent text and digest-bound deterministic evidence,
and downloads the review request. It cannot write a decision, activate,
rollback, mount a plugin, access credentials, start a model request or expose a
model-visible tool. A later Cordis panel may render the same read model after a
separate mount approval, but cannot own promotion authority.

## Consequences

- Positive: capability generation, evaluation, human decision and deployment
  have distinct records and failure paths.
- Positive: the prior active generation remains immediately restorable until a
  canary completes.
- Positive: the dashboard has no credential, pointer or profile-write surface.
- Negative: a qualified candidate waits for a human decision; a campaign no
  longer automatically completes with an activated generation.
- Negative: an attested local JSON decision does not prove reviewer identity or
  non-repudiation. GitHub protected review or a signing broker remains a future
  integration if that assurance is required.

## Confirmation

- Focused tests stage an eligible candidate, reject malformed/stale decisions,
  verify no activation before approval, exercise approval, canary compensation,
  rejection and loopback dashboard boundaries.
- The full repository gate covers schemas, privacy checks, package build and
  consumer smoke. No external service call is part of dashboard verification.

## Research basis

- [Argo Rollouts](https://argoproj.github.io/argo-rollouts/) separates stable
  and canary revisions, analysis, manual judgement and rollback.
- [Argo rollback windows](https://argoproj.github.io/argo-rollouts/features/rollback/)
  retain known-good revisions for fast restoration.
- [GitHub deployment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
  separate reviewers from jobs that access deployment secrets and can prevent
  self-review.
