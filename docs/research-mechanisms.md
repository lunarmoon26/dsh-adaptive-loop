# Research mechanism foundation

Change: `chg-research-mechanism-foundation-20261006`
Status: Implemented locally for Phase 1; later phases remain open.
Plan: [#21](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/21);
this slice: [#22](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/22).

## Boundary and architecture

The real OpenCode/DSH research workflow separates the task harness H from the
improvement mechanism I and the protected control plane K. I contains diagnostic
and proposal instructions, a declarative search strategy and an experience-selection
policy. K owns capabilities, exact approvals, maximum resources, evaluator identity,
audit and rollback. A mechanism is data, not executable code or authority. Natural
language instructions remain untrusted; shape/privacy checks are not semantic safety.

This first slice validates and stages I and prepares private worker requests for an
existing artifact-campaign reservation. It does not launch OpenCode/DSH, invoke a
model, activate I, select work automatically or change the tool-free live loop.
The existing campaign schemas and historical digests remain unchanged. For this
opt-in preparation path, `plan.researcher_sha256` identifies the complete canonical
mechanism and `plan.policy_sha256` identifies its search and experience policies.
Historical plans whose researcher identifies something else remain ledger-valid
but cannot use this preparation path without a new frozen plan.

## Observable contract

1. A strict `research-mechanism.v1` includes an explicit nullable parent digest,
   bounded instructions and closed declarative policy fields. Identity uses JCS
   SHA-256 over the entire document. Staging a child requires its previously staged
   parent; parents are verified by content, not a caller-supplied name.
2. `dal research mechanism check --file <file>` validates a repository JSON file
   and returns identities only. `stage` publishes validated content privately at
   `.dal/research/mechanisms/<digest>.json`, with exclusive/idempotent publication.
   It installs nothing, creates no active pointer and authorizes no use.
3. `dal research prepare --binding <file>` consumes a strict local binding. The
   binding names a campaign, pending node, mechanism, task contract, task harness
   and exact one-to-one repository file bindings for all reserved artifact inputs.
   The mechanism must be staged. The task contract's exact byte digest must equal
   the reservation's `contract_sha256`. The task harness is a reserved, accepted
   input with kind `task-harness`. All reserved inputs, including the workspace
   snapshot, are read and byte-verified; duplicates, extras and missing inputs fail.
4. Files are bounded regular files read with checked descriptors and no symlink
   traversal. Workspace/artifact references represent one file's bytes, not an
   imported runtime closure or a restored directory. Safe reads do not prevent a
   later concurrent same-user mutation; the executor must reverify at dispatch.
5. The prepared request binds the plan, reservation, observed ledger head, I, H,
   task contract, worker and artifact digests. Instructions are assembled from the
   verified mechanism and harness. The task contract is private JSON data, not an
   authority record; the caller must exclude oracle/holdout content. No raw artifact
   contents or instructions are added to the campaign ledger or feedback stores.
6. One immutable request exists per campaign node under
   `.dal/research/requests/<campaign>/<node>.json`. Identical preparation is
   idempotent while the reservation remains pending; different bindings or changed
   ledger state are rejected rather than overwriting. Preparation neither reserves
   resources again nor spends them. It refuses recorded results, unknown outcomes
   and reported campaign overruns.
7. `dal research verify --file <request>` first matches the exclusively published
   per-node request, then reconstructs it from current mechanism, campaign and
   artifact bytes and rejects drift. It prints identity
   metadata only. This proves local request preparation, not worker consumption,
   independent execution, resource enforcement, evaluator validity or L4 progress.

The reader caps source JSON at 256 KiB, task contracts/harnesses at 64 KiB and
individual opaque artifact files at 16 MiB. Mechanism instructions are at most
20,000 UTF-8 bytes each; serialized private requests are at most 512 KiB. Larger
research artifacts require a separately reviewed adapter design, not truncation.
Appending any campaign event invalidates a prepared request's observed head; an
immutable request is never silently refreshed. Parallel dispatch/re-preparation
semantics remain an explicit adapter design task in #23. The writer lease covers
cooperative local writers, not malicious same-user lock deletion or filesystem
replacement. Never remove a live writer's lock as a recovery shortcut.

Exact persisted fields live in the three `research-*.v1.schema.json` schemas.
Private files are owner-only on creation and ignored by VCS. User-selected source
files remain the user's retention responsibility. The public API is exported as
`@lunarmoon26/dal/research`; adapters obtain the verified request in memory and
must enforce approvals/isolation before passing it to any worker.

## Implementation order and claim gates

| Phase | Issue | Required evidence |
| --- | --- | --- |
| Mechanism/request foundation | [#22](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/22) | Strict contracts, byte verification, immutable preparation and packaged API |
| Trusted execution adapter | [#23](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/23) | Actual OpenCode/DSH consumption, independent runtime/evaluator evidence, enforced allocations |
| Mechanism comparison | [#24](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/24) | Fresh matched-budget campaigns, independent confirmation, costs and uncertainty |
| Successor activation | [#25](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/25) | Exact human approval, atomic handoff, downstream consumption and rollback |
| Sustained recursive gains | [#26](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/26) | Repeated real research cycles against credible fixed/no-change baselines |

Mechanism development, fresh qualification and sealed confirmation are distinct.
Replay screens candidates; it cannot infer unexplored outcomes. Candidate-specific
human promotion stays mandatory. Governed recursive improvement and autonomous L4
are different claims. No model weights, general generated-code runner or HMR
activation are required by this design.

## Local evidence and remaining inputs

On 2026-10-06, the repository gate passes with 1,333 tests passed and seven opt-in
integration skips. The research foundation/reader suites contribute 47 passing
tests. Eight packaged artifacts pass clean-consumer smoke, including research
request assembly through the installed API and metadata-only verification through
the installed CLI. Review found no remaining issues within this local boundary.
These checks do not run an OpenCode worker, a DSH research agent or a private grader.

Phase 2 targets the existing project-local ACP bridge and separately owned research
evaluator. Before live work, the maintainer supplies a frozen task set, evaluator
entry point/context and named resource budget; the adapter contract must join their
receipt identities and actual containment guarantees. Exact runtime, send and
deployment approvals remain operation-owned. The full roadmap is not completed
by this foundation, and no recursive-improvement gain is claimed.
