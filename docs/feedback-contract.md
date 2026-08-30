# Feedback Contract

Status: Accepted
Canonical behavior owner: this document
Exact syntax owner: [`../schemas/feedback-log.v1.schema.json`](../schemas/feedback-log.v1.schema.json)

## Producer obligation

Every feature-change task emits one feedback log before it is reported complete. The producer writes concise summaries and evidence references; it does not paste raw transcripts, prompts, source files, command output, environment variables, tool arguments, or credentials.

The log is useful even when work cannot complete. `blocked` and `aborted` are explicit outcomes, not reasons to omit the log. Only a process loss that prevents all writes can leave no record; the next human or agent records that gap as a new observation rather than fabricating task facts.

## Required sections

| Section | Meaning |
| --- | --- |
| `schema_version`, `feedback_id`, `change_id`, `created_at` | Stable contract, record, change, and time identities |
| `supersedes` | Prior feedback ID corrected by this record, or `null` |
| `producer` | Actor, dsh/session identity when available, repository identity, and task reference |
| `goal` | Intended user-visible outcome |
| `acceptance_criteria` | Stable criterion IDs, statements, results, and evidence IDs |
| `outcome` | `completed`, `blocked`, or `aborted`, summary, and explicit exception |
| `what_worked`, `what_failed` | Reusable positive and negative observations |
| `calls` | Safe summaries of tool, harness, and plugin calls in sequence |
| `failures_and_inefficiencies` | Categorized friction, impact, recovery, and evidence |
| `evidence` | Typed references to tests, commands, files, commits, session events, URLs, or human notes |
| `uncertainty` | Unknowns, confidence, and smallest resolution action |
| `human_review` | Review state, reviewer identity if supplied, decision time, notes, and approval references |
| `privacy` | Classification, retention, tags, personal-data declaration, and explicit redactions |

## Identity rules

- `feedback_id` is unique and immutable. A correction gets a new ID and names the old ID in `supersedes`.
- `change_id` groups records about one feature change and may appear in several feedback logs.
- IDs use lowercase ASCII letters, digits, dots, underscores, and hyphens with a typed prefix such as `fb-`, `chg-`, `ac-`, or `ev-`.
- Evidence IDs are unique within one feedback log. Every evidence reference from criteria, calls, failures, or uncertainty resolves to one local evidence item.
- Call `sequence` values are positive, unique, and strictly increasing in array order.

## Outcome rules

### Completed

- `outcome.exception` is `null`.
- Every acceptance criterion is `passed` or `not_applicable`.
- At least one criterion is present.
- `human_review.status` may be `not_requested`, `pending`, `approved`, `changes_requested`, `rejected`, or `not_required`; the field reports fact, not implied authorization.

### Blocked

- `outcome.exception.kind` is `blocked`.
- The exception names a concrete reason, owner, and next action.
- Criteria may be `passed`, `failed`, `not_run`, or `not_applicable` and retain partial evidence.
- The task result says `blocked`; it does not claim completion.

### Aborted

- `outcome.exception.kind` is `aborted`.
- The exception names why work stopped, who owns follow-up, and what happens next.
- Partial calls, failures, and evidence remain in the record.
- The task result says `aborted`; it does not claim completion.

## Call and evidence minimization

A call records only:

- sequence;
- `tool`, `harness`, or `plugin` kind;
- stable name;
- purpose;
- `succeeded`, `failed`, `cancelled`, or `denied` result;
- optional duration;
- referenced evidence IDs.

Do not store arguments or output. An evidence item points to a durable location using a URI such as `repo://tests/store.test.ts`, `command://pnpm-test`, `commit://<sha>`, `dsh-session://<session>/<seq>`, or an `https://` public source. `summary` states what the evidence proves. Optional SHA-256 binds file-like evidence to exact content.

## Human review versus sensitive-action approval

`human_review` reports whether a person reviewed this task record. It is not authorization for a sensitive action. Sensitive actions use a separate approval decision conforming to [`../schemas/approval-decision.v1.schema.json`](../schemas/approval-decision.v1.schema.json) and the policy in [`governance.md`](governance.md).

## Privacy and redaction

- `classification` is `public`, `internal`, or `restricted`; default team use is `internal`.
- `retention` is `local-only`, `team`, or `ephemeral`.
- `tags` are explicit routing labels such as `no-secrets`, `redacted`, `personal-data`, or `customer-data`.
- `contains_personal_data` is a required producer declaration.
- Every intentional replacement appears in `redactions` with a JSON pointer, reason, and marker such as `[REDACTED:credential]`.
- Ingestion scans all string leaves. A likely secret fails the write; the system does not silently alter the producer's record.

Secret scanning cannot prove safety. A valid record may still be confidential, identifying, licensed, or contractually restricted. Producers and reviewers follow [`governance.md`](governance.md).

## Versioning

`1.0.0` is the only accepted feedback schema version in v0. Additive optional fields still require a new schema artifact and compatibility decision; persisted readers never guess at unknown versions. Structural breaking changes get a new major version and a documented migration before readers accept them.
