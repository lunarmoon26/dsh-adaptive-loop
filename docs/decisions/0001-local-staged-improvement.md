# 0001: Keep v0 local and stage every improvement before application

Status: Superseded by [`0003-purpose-specific-approved-executors.md`](0003-purpose-specific-approved-executors.md)
Date: 2026-08-27
Related: [`../spec.md`](../spec.md), [`../architecture.md`](../architecture.md), [`../governance.md`](../governance.md)

## Context

Task feedback can contain repository details, failure evidence, personal notes, and accidental credentials. Optimizer candidates can change high-leverage prompts, skills, plugins, and harness configuration. dsh already exposes project instructions and local skills without shared configuration changes, while its Cordis composition can mount more powerful plugins through profile patches. GEPA and SkillOpt can generate candidate text, but their evaluation success does not establish organizational permission or safe application.

The first version needs useful capture and review without creating an autonomous mutation or external-data path.

## Decision drivers

- Prevent secret capture and unreviewed external transfer.
- Preserve provenance and allow offline team queries.
- Make the current/future boundary obvious and testable.
- Integrate with dsh without editing shared profiles or installing a plugin.
- Keep optimizer choice replaceable while retaining one human approval policy.
- Permit a later Cordis plugin without making v0 records disposable.

## Options considered

### Local immutable records plus staged proposals

- Helps because records remain inspectable, provider-neutral, and available without a service.
- Helps because candidate generation, evaluation, approval, and application remain separate facts.
- Hurts because directory scans and manual collection do not scale indefinitely.
- Hurts because project instructions cannot guarantee a final write after process loss.

### Reuse only dsh session feedback and telemetry

- Helps because feedback already belongs to the session lifecycle.
- Hurts because the current `feedback/record` payload is free text, has no query surface, does not force a flush, and may participate in configured sharing.
- Hurts because team feedback would remain coupled to session storage and deployment policy.

### Install a Cordis plugin that automatically learns and applies

- Helps because lifecycle events could capture richer facts and act without a second command.
- Hurts because it changes shared harness behavior, expands the trust boundary, and can turn evaluation errors into broad configuration regressions.
- Hurts because dsh and optimizer interfaces are still pre-stable.

### Hosted feedback and optimizer service

- Helps because indexing, concurrency, and team access are easier.
- Hurts because data leaves the local boundary and requires identity, authorization, retention, tenancy, and incident controls outside v0 scope.

## Decision

Use local immutable feedback envelopes, versioned schemas, compact source-bound capsules, and staged improvement records. Integrate with dsh through repository instructions and a project-local skill only. Keep optimizer adapters disabled and require a separate scoped human approval at every sensitive-action execution boundary.

## Consequences

- Positive: v0 is useful without credentials, network access, optimizer dependencies, or dsh profile changes.
- Positive: a future GEPA, SkillOpt, or Cordis integration must consume the same reviewed records and produce the same provider-neutral candidate evidence.
- Positive: sensitive actions fail closed and remain independently auditable.
- Negative: end-of-task enforcement depends on workflow compliance until a lifecycle plugin exists.
- Negative: team aggregation is filesystem-based and does not provide concurrent remote synchronization.
- Negative: humans perform more explicit review and application steps.
- Follow-up: design a Cordis capability seam only after real v0 records establish the required event, command/tool, persistence, and UI consumers.

## Confirmation

- Tests reject secret-bearing records and conflicting immutable IDs.
- Tests reject human-only transitions from an agent actor.
- Tests reject wrong-scope, wrong-action, rejected, or expired approvals.
- The dependency graph and CLI contain no network client, optimizer package, shared-config writer, installer, or candidate applier.
- README commands run without external credentials.
