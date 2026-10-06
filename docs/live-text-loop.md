# Live text-harness campaign

Change: `chg-dal-live-text-loop-20260916`. Status: Implemented; native pilot evidence
is recorded separately in `requirement-evidence.md`.

## Scope

The first live loop evolves bounded prompt/skill text for independently graded
structured-output tasks. It uses native DSH LLM, pi-ai Codex and local credential
services in a fixed trusted Cordis host. There is no agent, tool dispatcher, shell,
workspace discovery, HMR, shared profile, executable candidate, or model-controlled
file path. Returned text is parsed as data and never executed. This is a tool-free
capability boundary, not a claim of OS sandboxing for arbitrary plugins.

The native provider owns subscription authentication and refresh. DAL does not copy
or inspect credential values. Native credential refresh may update the operator's
existing store. The adapter mounts only the approved fixed services, sets no API
key override, and makes no fallback to another provider. It loads no DSH profile,
home patch, settings overlay or `.env` file. Native usage is recorded when available;
it is not dollar billing. Requests have finite timeout and output limits, no tools
and no automatic retries. Incomplete, tool-bearing and malformed responses fail.

This versioned live path is separate from the historical v0 proposer and replay
commands. Existing exact-action decisions retain their original semantics. A new
campaign grant binds the exact plan digest, actions, workspace, expiry and budgets;
the human explicitly delegates repeated text-only calls and local generation
selection within that scope. It never authorizes shared profiles or executable
plugins. Installation/mount approval of the trusted native services is separate.

## Loop and authority

The plan freezes the broad goal, base prompt, model, development/qualification
cases, deterministic grader, minimum gain, maximum candidates and finite request
allocation. Qualification inputs are sent only to the executor and never to the
candidate generator; expected outputs never leave the grader. Generator input
contains base/current prompt text and sanitized development check outcomes.
The generator returns a capability-gap hypothesis, proxy, mechanism and a bounded
replacement prompt. The controller evaluates baseline and candidates on the same
cases. Development evidence guides generation; qualification selects winners and
is not described as an untouched holdout.

Each live rollout has one fixed declarative exploration policy. It selects a batch
of the root or currently unexpanded leaves, then each selected parent produces one
child candidate and deterministic evaluation. State persists a parent-linked
discovery tree with the evaluated development/qualification score and evaluation
digest for every node. The controller derives a read-only workspace BPE projection
from verified state: **Belief** contains development status plus input/response
digests, **Progress** contains phase and finite candidate allocation, and
**Experience** contains development scores for evaluated generations. The generator
receives this development-scoped view and already-authorized development inputs,
never qualification/canary inputs or outcomes, expected answers, raw replies or
mutable model memory.

`dal live dream --campaign <id> [--campaign <id>]` replays compatible complete
recorded trees under each bounded policy in the supported policy family. It starts
from each root, reveals only recorded child nodes after an identical policy batch
decision, and scores qualification quality, represented work and useful parallelism.
It invokes no model, evaluator, native service or new candidate generation. A replay
result is advisory evidence: a human places its selected policy in the next frozen
campaign plan and approves that plan before the next online rollout. Policy
code/configuration never changes during a rollout.

Before every call the controller revalidates authority, reserves a unique operation
durably, and then accesses native services. Failed or uncertain attempts consume
allocation. A pending operation after a crash is not automatically resent. Immutable
receipts bind request, generation, role, input and result digests. Results are graded
by fixed local code. Resuming a completed operation reuses verified evidence.
Concurrent supervisors cannot hold the same campaign lease.

Only a strict qualification gain with no baseline-passing case regression qualifies
for review. Prompt generations are content-addressed. Search records
`awaiting_review` while leaving the workspace-local active pointer unchanged. The
separate promotion executor requires a human-attested, exact current decision for
the candidate, evaluation, incumbent and pre-review state before switching that
pointer. The original skill file and existing shared profiles are not rewritten.
Post-activation verification uses that pointer and compensates a failed canary to
the prior retained prompt. A manual rollback can select only a previously retained
generation. No-op retention is a successful campaign result, not an improvement
claim. See [live promotion control](live-promotion-control.md).

## Acceptance criteria

1. Native text-only calls use the approved Codex route with native credentials,
   bounded output/time, terminal completion and privacy-safe usage receipts.
2. Wrong scope, expired/revoked grants, exhausted allocations, source drift and
   unapproved service mounting fail before credential access or transmission.
3. Baseline, fixed-policy hypothesis/candidate generation and
   development/qualification evaluation compose into a parent-linked discovery tree.
   Search stages strict selections for review without activating a candidate.
4. Resume cannot double-send a pending operation; concurrent runs are excluded;
   receipts and current generation are verified before use.
5. Candidate text cannot alter budgets, grader, authority, runtime or filesystem
   targets; evaluator answers never reach the generator or task executor.
6. Replay evaluates alternative bounded policies from prefix-only recorded trees
   without new execution. An exact human decision binds promotion to the staged
   candidate and evidence; focused tests cover rejection, decision drift,
   activation, canary compensation and recovery paths.

## Commands and persistence

`dal live demo --campaign <id>` writes a synthetic metric-comparison plan with a
deliberately weak constant-output seed. It contains no competition data. This is a
runtime demonstration, not a claim of improving an existing research harness.
`dal live prepare --plan <file>` freezes the plan, base generation and initial
state, and returns the exact plan digest and native-service mount scope. Both are
needed before live execution. Preparation makes no model call or credential read.

The operator provides a human `campaign-grant.v1` for `send_text`,
`activate_prompt`, and `rollback_prompt`, and a separate legacy mount decision for
the returned scope. `dal approval verify <grant> --plan <plan> --action
send_data_externally --scope <plan-digest>` verifies the delegated transfer scope;
`apply_optimization_candidate` maps to `activate_prompt` only on this explicit
`--plan` path. Legacy approvals are never interpreted as campaign grants.

`dal live run --campaign <id> --grant <file> --mount-approval <file>` drives
fixed-policy search and stages an eligible candidate for review. `dal live status
--campaign <id>` validates the state chain, regrades referenced task receipts and
reports allocations, best evaluated, eligible selection, actual active generation
and digest-only BPE. `dal live review --campaign <id> [--port <port>]` starts a
loopback-only read dashboard and downloads the exact review request; it has no write
endpoint. The reviewer creates an out-of-band human decision, then `dal live
promote --campaign <id> --grant <file> --mount-approval <file> --approval <decision>`
revalidates it, switches the pointer and runs the canary. `dal live reject
--campaign <id> --approval <decision>` records a human rejection without changing
the pointer. `dal live task` takes an approved case ID and a
unique `--operation task-...` identity, then runs that case with the current prompt.
It shares campaign allocations and cannot introduce unapproved task input.
`dal live rollback` restores the preceding retained generation under the grant.
`dal live revoke` prevents further calls/promotions. `dal live recover` releases a
stale lease only when its recorded local process no longer exists; pending call
intents remain non-retryable. A live failed campaign requires a new plan/grant to
start new attempts; no automatic resend, refund, budget reset or hidden retry exists.

All campaign artifacts live under `.dal/live/<id>/`. Exact JSON owners are
`live-plan.v1`, `campaign-grant.v1`, `live-generation.v1`, `live-operation.v1`,
`live-state.v1` and `live-review.v1` (including pointer/lease/revocation and
review-request/decision definitions). Multi-world replay outputs use
`live-dream.v1` under `.dal/live/dreams/`. `current.json` is an atomic pointer to a
hash-linked state snapshot and content-addressed prompt.
An interrupted snapshot/pointer publication is reconciled by authorized `live run`.
The private artifact store can contain approved prompt and structured response
objects; these contents never enter feedback logs, capsules or the team run store.

The grant fixes complete inputs and finite requests, not unknown future response
bytes. It does not replace the candidate-specific human approval required for
promotion. Automatic compensation after a post-approval probe failure restores only
the exact previously retained prompt even if the grant expired or was revoked while
a call was in flight; it sends nothing and cannot install a novel generation.
Revocation stops new calls, not an already dispatched provider request. The timeout
includes a bounded five-second host startup/termination allowance. Missing usage
remains unknown; failed attempts retain their allocation.

The native host is a separate package with Cordis 4.0.4 and DSH 0.2.0-rc.2 services,
aligned with the root runtime release set. See [compatibility](distribution.md#dsh-compatibility)
for migration evidence and limits. Runtime identity pins compiled
DAL code, schemas and native entry bytes. It is an operation-time integrity check
for this trusted host, not the general imported-closure attestation required for
arbitrary executable-plugin evolution. This implementation does not mount those
peer services merely because their packages are installed.

## Dependency approval

Historically, the maintainer explicitly approved installation of Cordis 4.0.2 and native DSH
LLM, pi-ai and credentials-local 0.1.5-rc.2 plus resolved dependencies into this
repository only. Decision `dec-native-text-dependencies-20260916` records that
installation-only scope; it grants no runtime mount, credential use or live call.
That historical decision is not transferred to a new runtime generation. The
0.2.0-rc.2 source migration does not update an installed host or approve a live
campaign; operation-time identity and exact approvals remain required.
