# 0006: Stage approved plugin candidates through existing HMR

Status: Accepted
Date: 2026-09-04
Related: [`../spec.md`](../spec.md), [`../architecture.md`](../architecture.md), [`../governance.md`](../governance.md), [`0003-purpose-specific-approved-executors.md`](0003-purpose-specific-approved-executors.md)

## Context

Skills and instructions alone cannot evaluate changes to DSH's live Cordis capability graph. DSH already provides transactional plugin HMR and emits a success-only `hmr/reload` event, while failed activation restores the prior plugin runtime. Adding a second loader or patching DSH core would duplicate that ownership. Editing watched source directly is also unsafe because HMR can apply incomplete or unapproved bytes before their exact digest is reviewed.

## Decision drivers

- Reuse DSH's existing plugin lifecycle and rollback behavior without a DSH patch.
- Verify exact candidate approval at the filesystem mutation boundary.
- Attribute benchmark runs only to one stable, successfully activated generation.
- Keep every writable path and the promotion decision outside agent control.

## Options considered

### Patch DSH with an audit-grade runtime-generation service

- Helps by observing every Loader mutation globally.
- Hurts by coupling DAL to a broad DSH core/vendor change that is unnecessary for one isolated candidate loop.

### Edit the watched plugin files directly

- Helps by using HMR with almost no DAL code.
- Hurts because writes can activate before exact approval and multi-file edits can expose partial candidates.

### Stage, approve, then publish through one coordinator

- Helps because inactive staged files have a reviewable digest; the coordinator can verify it immediately before publishing dependencies and the entry file, then admit only the matching successful HMR event.
- Hurts because authoring needs a staging copy and a process crash still requires git-based recovery.

## Decision

Use `@lunarmoon26/dal-hmr-candidate` as a purpose-specific executor in an isolated linked worktree. Its startup configuration fixes one loaded entry, a bounded file list, staging and approval paths, approval scope, and DSH version/profile. It stages inactive copies, invokes the fixed local `pnpm dal approval verify` command for the complete staged digest, writes dependencies before the entry, consumes public `hmr/reload`, and restores the in-memory baseline on failed admission or explicit rejection. `dal-run-record` binds the current candidate ID, digest, base git tree, DSH version/profile, and HMR sequence at `session/created`; any later successful reload makes the run ineligible.

The coordinator cannot install or mount itself, edit a profile, choose arbitrary paths after startup, change an evaluator, or commit/promote a candidate. Human git review remains the only promotion path.

## Consequences

- Positive: plugin implementation and imported configuration modules become measurable adaptation surfaces without DSH core changes.
- Positive: approval, HMR activation, session attribution, rollback, and promotion remain distinct facts.
- Negative: only configured files are covered; profile YAML, skills, and instructions retain their existing human application path.
- Negative: HMR success proves plugin activation, not task quality or production safety.
- Follow-up: execute and pin a real DSH Loader/HMR composition probe before claiming that integration beyond event-contract tests.

## Confirmation

- Coordinator tests cover exact approval, successful matching reload, unrelated reload, timeout rollback, explicit rejection, and linked-worktree enforcement.
- Run-record schema and tests require a stable admitted generation for `evaluation_eligible: true`.
- Bundle tests keep the coordinator disabled until a separately approved profile mount.
- Repository checks remain credential-free and make no provider request.

## Links

- Refines the no-generic-executor boundary in [`0003-purpose-specific-approved-executors.md`](0003-purpose-specific-approved-executors.md).
