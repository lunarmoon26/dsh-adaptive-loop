# dsh-adaptive-loop — user-global agent instructions

Installed at `~/.dsh/AGENTS.md`. Applies to every dsh session in every workspace. Keep this file minimal: it points at the skill and states the record requirements.

## End of every feature-change task

When you complete, block, or abort a feature-change task (implementation, bug fix, refactor, migration, or other repository change), use the `end-task-feedback` skill: write a `feedback-log.v1` JSON record under `<workspace>/.dal/outbox/`, then run `dal feedback validate <file>` and `dal feedback ingest <file>`, and report the stored record path. Never omit the record because a task did not complete.

## Failure traces

When a task fails on deterministic evidence (tests, build, type errors, policy denial, privacy rejection, schema invalidity, capsule drift, evaluation hard stop, runtime error, timeout, or budget breach), write a run record for that attempt and ingest it with `dal run ingest <file>` before closing the task. Include the structured failure facts and the pinned context required by the run-record schema.

## Safety boundaries

- Never change shared harness configuration, install or mount plugins, send project data externally, or apply an optimization candidate without a separate exact human approval.
- Improvement proposals may target only the editable surfaces (`prompt`, `tool_descriptions`, `skills`, `memory_policy`, `routing`, `stop_retry_logic`, `harness_code`). Never propose a change to the evaluator, sealed holdout, permissions, maximum budget, promotion policy, audit log, or rollback mechanism.
- Deterministic checks may block but never authorize. Keep raw transcripts, tool arguments and output, source contents, environment values, and secrets out of every record.
