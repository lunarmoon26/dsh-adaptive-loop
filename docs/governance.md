# Human Approval and Data Governance Policy

Status: Accepted
Policy owner: project maintainers
Machine owner for approval syntax: [`../schemas/approval-decision.v1.schema.json`](../schemas/approval-decision.v1.schema.json)

## Default posture

`dal` is local-only and human-governed. Observation, validation, local ingestion, local query, and proposal staging do not grant authority to mutate the harness or send data. Absence, ambiguity, expiry, or mismatch in an approval decision fails closed.

Deterministic guardrail denial also fails closed and cannot be overridden by a prompt, repository instruction, optimizer score, model judge, or ordinary task review. See [`evaluation-and-guardrails.md`](evaluation-and-guardrails.md).

## Actions that require approval

| Action | Approval action value | Required scope |
| --- | --- | --- |
| Change a shared dsh profile, `$DSH_HOME`, home-level instructions, shared prompt, or shared `cordis.patch.yml` | `change_shared_harness_config` | Exact file or configuration identity |
| Install, update, remove, or mount a Cordis/dsh plugin | `install_or_mount_plugin` | Exact package, version/digest, profile, and operation |
| Send feedback, source, prompts, capsules, traces, or evaluation data outside the local machine or approved local boundary | `send_data_externally` | Destination, data class, dataset digest, and purpose |
| Apply an optimization candidate to any prompt, skill, plugin, rule, or harness configuration | `apply_optimization_candidate` | Exact proposal ID, candidate digest, and target artifact |

One decision authorizes one action and one scope. A review comment, task approval, schema-valid feedback record, optimizer score, or sandbox success is not a substitute.

## Decision requirements

An approval decision contains:

- stable decision and request IDs;
- one sensitive action;
- exact scope string and scope SHA-256;
- `approved` or `rejected` decision;
- human reviewer identity;
- decision and expiry timestamps;
- evidence and rationale;
- candidate digest when candidate application is requested.

The verifier accepts only `approved` decisions whose action and scope match exactly and whose expiry is in the future. Rejected decisions remain durable evidence. Changing scope or candidate requires a new decision.

The tau-style e2e driver (`pnpm benchmark:e2e`) applies this binding to whole run batches: its transmission-manifest digest covers the provider, model, generation, rollout count, runner, fault/resolution profile, container image digest, baked workflow-tools bytes, agent-visible and evaluator-task digests, driver-source digests, policy, skill, exact rendered composition-patch text, and exact prompts. The patch uses a stable service alias, so approval binds executed text without attempt-specific paths. A skill, task, harness plugin, image, patch, provider, or rollout-count change therefore invalidates prior batch decisions. After verification, the exact manifest is published as immutable evidence; every attempt rehashes its staged inputs before the model call, receipts bind the manifest and real run ID, summaries bind the persisted run-record path/digest, and every container launches by the approved image digest rather than its mutable tag. The compare gate rejects reused receipt/run evidence and verifies business outcomes before recomputing summary metrics. The driver accepts only `g0`/`g1`; source-only G2 cannot be claimed as an executed generation. Docker candidate/service/grader isolation does not weaken the separate `send_data_externally` approval required before the model call.

The G2 unknown-effect guard is repository source with a disabled bundle row, not an authorized installation or applied optimization. Mounting its package into any profile requires an exact `install_or_mount_plugin` decision. Promoting the same bytes as an optimization candidate separately requires an exact `apply_optimization_candidate` decision bound to the candidate digest. Either action must identify the target profile/generation and rollback generation; one approval cannot imply the other.

### Proposed DSH permission-escalation adapter

DSH's inspected `approval/request` waterfall supports optional one-shot answerer plugins and fails closed when no answerer can decide. A future DAL adapter may answer only after trusted operation metadata is joined to the DSH call and the exact DAL action, scope, target digest, decision, and expiry verify at that operation. The DSH request itself carries a tool name, reason, and optional call ID but no tool arguments, so `allowed-once` alone is not an DAL sensitive-action approval.

Headless/CI composition defaults to deterministic rejection when no approved answerer is present. Slack, webhook, ticket, or other remote answerers are not part of v0; installing one requires plugin approval, and transmitting the request or decision outside the approved local boundary separately requires `send_data_externally` approval. A DSH sandbox escalation does not imply permission to change shared configuration, install a plugin, transfer data, or apply a candidate.

## Separation of duties

- An agent or automated normalizer may observe, normalize, and draft a proposal.
- A human reviews normalized observations before proposal evaluation proceeds.
- A sandbox evaluator may produce a score and evidence but cannot approve or apply.
- A human approves or rejects an evaluated proposal.
- The operation that changes a target independently verifies the sensitive-action approval at its execution boundary.
- Post-application measurement does not retroactively authorize the application.

v0 provides verification and transition recording plus three narrowly scoped executors: user-global install writes only the fixed governed assets, while proposer and benchmark e2e send only their exact digest-bound projections. It deliberately provides no generic shared-config writer or external sender, plugin installer or mounter, optimizer runner, or candidate applier.

## Data collection rules

Allowed by default:

- concise task goals and acceptance statements;
- pass/fail/not-run outcomes;
- tool, harness, and plugin names with safe purpose/result summaries;
- relative repository references, commit IDs, test command labels, and content digests;
- bounded uncertainty and human-review notes;
- redacted internal observations classified for local or team retention.
- deterministic action metadata, policy rule IDs, bounded budgets, fixture identities, and scorecard metrics that contain no raw payload;

Prohibited from feedback records and capsules:

- credentials, tokens, cookies, private keys, connection strings, and environment-variable values;
- raw tool arguments or outputs;
- full transcripts, chain-of-thought, hidden reasoning, or system prompts;
- source-file contents when a path and digest suffice;
- customer payloads, production data, regulated data, or personal data without an explicit organizational basis and restricted handling;
- absolute home paths when a repository-relative reference suffices.
- unredacted email addresses, phone numbers, government identifiers, payment-card numbers, or other likely PII in records or capsules.

## Redaction and secret handling

1. Minimize before redacting: omit unsafe material when a reference proves the fact.
2. Replace unavoidable sensitive substrings with a typed marker such as `[REDACTED:credential]`.
3. Record each replacement in the feedback `privacy.redactions` list.
4. Run validation plus secret and PII scanning before ingestion.
5. If scanning rejects a record, persist nothing. Correct the source record; never disable a rule or relabel unsafe content to make a task pass.
6. Treat scanning as defense in depth. Human review remains required for restricted data and every external transfer.

## Provenance and integrity

- Ingestion records the source path as a display reference, its SHA-256, the original feedback SHA-256, secret and PII scan rule-set versions, and ingestion time.
- Stored feedback IDs are immutable. Corrections supersede rather than overwrite.
- Capsule claims identify sources, commit or version where applicable, content digest, and freshness dates.
- Optimization candidates identify the exact base artifact digest. A changed base invalidates application authority.
- Evidence summaries state what is directly observed, inferred, or unknown.
- Guardrail decisions bind the request and policy digests plus the approval reference and approval-content digest when supplied; evaluation scorecards embed and digest the suite and policy snapshots and bind fixture-set and target digests.

## Retention and deletion

- `ephemeral`: do not ingest into the team store; delete the working record after the task's authorized evidence window.
- `local-only`: retain only in a developer-controlled local store.
- `team`: retain in the team's approved local/shared filesystem according to team policy.
- `restricted`: requires an owner and retention decision outside this project before team aggregation or external transfer.

v0 has no delete command to avoid accidental evidence loss. A human deletes records using an approved repository or filesystem procedure after reviewing provenance, retention obligations, and backups. A later retention tool must use tombstones or an auditable deletion receipt.

## Incident response

If a secret or prohibited payload is ingested:

1. Stop queries and synchronization involving the store.
2. Revoke or rotate the exposed credential through its owning system.
3. Identify every copy using record and source digests.
4. Follow the store owner's approved deletion and backup procedure.
5. Record a redacted incident observation and improve the scanner or producer workflow without copying the secret.

## Policy limitations

- Local files are not encrypted by this project.
- The scanner cannot identify every secret or privacy obligation.
- A reviewer identity is an asserted local identifier; v0 does not provide cryptographic signatures or organizational authentication.
- The policy does not override employer, customer, legal, security, or data-retention requirements.
