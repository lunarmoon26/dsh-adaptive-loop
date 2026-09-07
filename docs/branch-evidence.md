# Branch Evidence

Status: Implemented (accepted contract)
Change: `chg-dal-proposer-receipt-boundary-20260906`
Exact machine owners: the branch-record, branch-evaluation, and execution-receipt v1 schemas.

## Contract

`recordBranch` accepts optional `candidatePath`. It records the actual file bytes
as `candidate_artifact_ref` and `candidate_artifact_sha256`, independently of the
proposal draft reference/digest. The existing evaluation `candidate_ref` and
`candidate_sha256` continue to mean the graded external state, not the artifact.
Historical records remain schema-valid; absent artifact binding is not proof.

Receipt-bound evaluations use `proof_version: branch-receipt-v1`. They pin the
draft, candidate artifact, full task file, state, optional effect log, and receipt
references and digests. Draft and artifact bytes are reloaded before evaluation.
The receipt must name the candidate artifact digest, exact task handle and
full task revision (`task_sha256`), state digest, exact effect evidence (including
absence), and a non-null digest of the recomputed complete grader verdict.
A nonempty session, base/candidate generation, model patch, event head, and
before-state binding are required. Receipt `task_sha256` is optional for schema
compatibility but mandatory for branch scoring.

Statistics validate stored schemas and replay the complete proof from current
referenced bytes. Stored scores, checks, and provenance booleans are not trusted.
Legacy records without the proof marker and diagnostic evaluations with false
provenance contribute no visits. Missing or changed proof files, malformed
records, and contradictory proof fail the entire query; only an absent store
is treated as empty.

Execution identity is the session plus task handle, independent of receipt ID,
candidate, and task revision. Publication uses its stable digest as evaluation
ID. An identical retry is idempotent (including concurrent exact retries);
different bindings or branches conflict. Statistics also deduplicate receipt ID,
receipt content, and execution identity across the whole store. Identical copies
count once; conflicting reuse fails closed. Concurrent conflicting publishers
with distinct execution identities are not a distributed transaction: any
receipt reuse that races publication is rejected by statistics, never counted
twice. References are identity-bearing; relocating proof is not an exact retry.

`execution_sha256` hashes `stableJson([dsh_session_id, task_handle])` and the
evaluation ID is `bev-` followed by that digest. For this proof version,
`receipt_sha256` hashes the exact receipt file bytes; historical unversioned
receipt digests are not reinterpreted. `receipt_content_sha256` hashes the
canonical receipt object excluding only `receipt_id` and `created_at`.

## Acceptance Criteria

1. Genuine artifact/task/state/verdict/effect bindings earn one visit per execution.
2. Wrong candidate, null verdict, missing task/base binding, or same-ID task drift fails.
3. Changed draft, artifact, task, state, effects, receipt, or derived evaluation fails replay.
4. Legacy true flags and receipt-less diagnostics never influence selection.
5. Retries and receipt/session reuse, including cross-branch reuse, cannot inflate scores.
6. Malformed evaluation files fail rather than returning silently partial statistics.

## Scope And Evidence

Focused evidence is `tests/branch.test.ts` and `tests/execution-receipt.test.ts`.
Verification on 2026-09-06: the focused Vitest run passes 43 tests; repository
TypeScript checking (`pnpm exec tsc -p tsconfig.json --noEmit`) and
`git diff --check` pass. This is focused component verification, not a full
repository check or a live harness experiment.
This is local evidence integrity, not independent signature attestation. A hostile
actor controlling the evaluator-owned store and all referenced files can forge
the entire chain. It does not prove execution, imported runtime closure,
independent evaluator ownership, full harness experiment comparability, or
candidate improvement. No model, network, application, or promotion is performed.
The CLI exposes artifact binding as `dal branch record --candidate <file>`.
Receipt producers opting into branch scoring supply `task_sha256` over the exact
full task file and the actual candidate artifact digest. Existing benchmark
receipts without these bindings require a newly executed receipt, not relabeling.
