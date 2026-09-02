# 0004: Separate the run-to-run supervisor from proposal lifecycle

Status: Accepted
Date: 2026-09-02
Related: [`../spec.md`](../spec.md), [`../architecture.md`](../architecture.md), [`../control-governed-evolution.md`](../control-governed-evolution.md)

## Context

DAL records task runs, clusters deterministic failures, evaluates bounded branches, and moves one candidate through a human-governed proposal lifecycle. Those records are observations and candidate evidence, but they do not estimate task-class state across batches or decide whether adaptation evidence is sufficient. Reusing proposal stages for that responsibility would mix the lifecycle of one candidate with the state of a harness generation.

The longer-term research direction adds a run-to-run supervisor, an adaptation-budget governor, an edit-response model, and a constrained predictive selector. The first increment needs a stable observation boundary without granting new execution, promotion, or application authority.

## Decision drivers

- Preserve the existing proposal lifecycle and its human checkpoints.
- Derive controller observations only from immutable, schema-validated run records.
- Keep evaluator, permissions, maximum budget, promotion policy, audit log, and rollback mechanism outside controller authority.
- Make repeated estimation deterministic and provenance-bound.
- Avoid a repository-wide directory migration before new ownership boundaries exist.
- Reserve the term model predictive control for a later implementation with an explicit response model, constraints, and receding-horizon replanning.

## Options considered

### Extend improvement-proposal stages with supervisor modes

- Helps by reusing one persisted state machine.
- Hurts because proposal state is candidate-scoped while monitor, diagnose, dwell, and drift state are task-class and generation scoped.

### Reorganize the repository around a complete target architecture first

- Helps by making the intended controller/evolution/evaluation/runtime layers visible immediately.
- Hurts because it creates broad import and ownership churn without adding an observable control contract.

### Add a separate, observation-only control subsystem

- Helps by preserving existing behavior while creating an explicit state-estimation seam.
- Helps by keeping sensitive operations behind their current purpose-specific approval and confinement boundaries.
- Hurts because the supervisor and proposal lifecycle must later be joined through explicit references rather than one shared enum.

## Decision

Add an internal `src/control/` subsystem and an immutable `controller-state.v1` record. `dal control estimate` reads one named batch from the run store, requires one compatible task set, measurement context, and harness generation, computes versioned proportion estimates with uncertainty, and publishes one deterministic state snapshot.

The controller state is evidence, not authority. It does not invoke a proposer, allocate executable budget, transition a proposal, evaluate or apply a candidate, call a model, send data, promote a generation, or execute rollback. Future governor and predictive-selection work consumes this state but remains separately contracted.

The existing guardrail, approval, evaluation, proposal, sandbox, and immutable-anchor boundaries remain authoritative. Unsafe candidate projection is not part of this decision; a candidate that crosses an immutable boundary continues to fail closed.

## Consequences

- Positive: task-class observation and candidate lifecycle have distinct owners.
- Positive: state estimation can be replayed offline without credentials or side effects.
- Positive: later PI and predictive-selection experiments receive a digest-pinned input contract.
- Negative: run batches with missing generation identity or mixed contexts cannot produce a controller state.
- Negative: failure clusters alone do not define a success-rate denominator; the first estimator uses explicitly configured harness, business, or deterministic-check outcomes.
- Negative: canary, rollback execution, hysteresis, dwell time, anti-windup, response learning, and MPC remain future work.

## Confirmation

- Contract tests cover policy validation, context/generation mismatch, sample sufficiency, Wilson intervals, deterministic identity, and immutable idempotent publication.
- CLI tests exercise `dal control estimate` without a model, network, optimizer, or candidate operation.
- The repository gate remains credential-free.

## Links

- Complements [`0003-purpose-specific-approved-executors.md`](0003-purpose-specific-approved-executors.md); it adds no executor.
