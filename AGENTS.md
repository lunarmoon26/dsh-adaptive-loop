# DSH Adaptive Loop project instructions

Read [`docs/spec.md`](docs/spec.md) before changing behavior. Exact persisted fields live in [`schemas/`](schemas/); update the owning schema, focused contract, implementation, fixtures, and evidence together.

## Required end-of-task feedback

For every feature-change task:

1. Assign a `chg-*` change ID and explicit acceptance criteria before implementation.
2. Keep raw transcripts, tool arguments/output, source contents, environment values, and secrets out of feedback. Use safe summaries and evidence references.
3. Before reporting the task complete, write a `feedback-log.v1` JSON record under `.dal/outbox/`, run `pnpm dal feedback validate <file>`, then run `pnpm dal feedback ingest <file>`.
4. Report the stored record path and focused verification evidence.
5. If work cannot complete, emit the same record with `outcome.status` set to `blocked` or `aborted` and a matching exception reason, owner, and next action. Never omit the record merely because the task did not complete.

Use the project-local `end-task-feedback` skill for the exact workflow and templates.

## Human approval

Do not change shared harness configuration, install or mount plugins, send project data externally, or apply an optimization candidate without a separate approved, unexpired decision for the exact action and scope. Verify it with `pnpm dal approval verify ...` at the operation that would make the change.

No v0 command runs GEPA, SkillOpt, another optimizer, or an LLM — except `dal propose run`, which invokes the configured model only after verifying an exact approved, unexpired `send_data_externally` decision whose scope digest binds the exact sanitized payload prepared by `dal propose prepare`. No v0 command changes dsh profiles or `$DSH_HOME`, except `dal install user-global --approval <decision-file>`, which writes only the `end-task-feedback` skill under `~/.agents/skills/` and the fixed user-global `AGENTS.md` under `$DSH_HOME`, and only after verifying an exact approved, unexpired decision at the operation. Keep other profile and optimizer behaviors future-only in [`ROADMAP.md`](ROADMAP.md).

## Context and verification

Validate a knowledge capsule before using it: `pnpm dal capsule check <path-or-directory>`. If a source digest or freshness date fails, inspect the canonical source and update the capsule through human review; never bypass or silently refresh it.

Run the smallest focused test first, then `pnpm run check` before closing a repository-wide change. Do not claim external-service, dsh runtime, optimizer, or sandbox proof unless that exact integration was executed.
