---
name: end-task-feedback
description: Complete the required DSH Adaptive Loop feedback record for any feature implementation, bug fix, refactor, migration, or other repository change. Use before declaring work complete, blocked, or aborted; this skill validates privacy-safe evidence, records the explicit exception path when needed, ingests the local record, and returns its provenance receipt.
user-invocable: true
---

# End-task feedback

Use this workflow at the end of every feature-change task. A task that is blocked or aborted still emits a record; only its outcome path changes.

## 1. Select the outcome

- `completed`: every acceptance criterion is `passed` or `not_applicable`; `outcome.exception` is `null`.
- `blocked`: progress depends on a missing input, capability, permission, or external result; set a matching `blocked` exception with reason, owner, and next action.
- `aborted`: the task was deliberately stopped; set a matching `aborted` exception with reason, owner, and next action.

Do not convert a failed criterion into `not_applicable` to claim completion.

## 2. Write the record

Copy the closest fixture from `tests/fixtures/feedback/` into `.dal/outbox/<feedback-id>.json`, then replace every fixture value with observed task facts.

Keep the record compact:

- summarize calls by name, purpose, result, and evidence ID;
- link tests, commands, commits, files, or dsh session events instead of copying payloads;
- state uncertainty and the smallest resolution step;
- report actual human-review state without treating it as sensitive-action approval;
- use `[REDACTED:<reason>]` markers and declare every redaction;
- never include raw tool arguments/output, transcripts, prompts, source content, environment values, credentials, customer payloads, or hidden reasoning.

## 3. Validate before persistence

```sh
pnpm dal feedback validate .dal/outbox/<feedback-id>.json
```

If validation or secret scanning fails, correct the source record. Do not disable a rule or paste the rejected value elsewhere.

## 4. Ingest and query the receipt

```sh
pnpm dal feedback ingest .dal/outbox/<feedback-id>.json
pnpm dal feedback query --feedback <feedback-id> --format json
```

Identical retries are safe. A reused feedback ID with different content is a conflict and requires a new ID plus `supersedes` when it corrects an earlier record.

## 5. Close the task

Report:

- `completed`, `blocked`, or `aborted` exactly;
- stored record path and feedback digest;
- focused tests and their observed result;
- unresolved decisions or next action;
- whether human review or any separate sensitive-action approval remains pending.

Do not claim that project instructions guarantee a record after a hard process loss. If a prior task has no record, create a new observation describing that gap without inventing the missing facts.
