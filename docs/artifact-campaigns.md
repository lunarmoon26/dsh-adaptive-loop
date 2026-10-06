# Artifact-aware research campaigns

Change: `chg-artifact-campaigns-20260929`
Status: Implemented; outer-harness integration remains adapter-owned
Semantic owner: this document; persisted syntax: `schemas/artifact-campaign*.json`.

## Boundary

This is a generic local evidence ledger for an outer harness such as OpenCode.
It records multi-round experiment lineage and a shared artifact dependency graph.
It does not call models, execute commands, read artifact bytes, train, select a
branch automatically, change profiles, promote policies, or activate `dal live`.
The existing text loop, grant and promotion schemas remain unchanged.

The outer harness owns execution, bounded verification and resource enforcement.
DAL validates declared identities, dependencies, reservations and review records.
Actor roles are local attestations, not authentication or proof of independent
execution. Artifact locators are opaque `artifact://<sha256>` references; private
paths, datasets, model bytes, transcripts and tool output stay outside the ledger.
Adapters resolve references and verify bytes/semantic compatibility before reuse.
Goal/hypothesis fields accept only reviewed single-line prose summaries; control
characters, code/array forms and common private path forms are rejected. Secret/PII
scanning and these shape checks do not establish semantic privacy. The adapter
must redact/summarize source evidence before submitting metadata.

## Contract and acceptance criteria

1. A frozen plan pins the goal, metric, evaluation context, researcher/policy,
   finite round/attempt/parallelism limits and named resource allocations.
2. A reservation precedes an attempt. Each node has one primary parent (or root),
   a task-contract digest, worker identity, expected compatible artifact inputs,
   workspace snapshot reference and explicit incremental resource reservation.
   Earlier reviewed nodes can be branched repeatedly. Reused inputs are not new
   artifact production and are not recharged by DAL.
3. Completion is not acceptance. A supervisor distinct from the declared worker
   reviews an exact result digest and explicitly accepts the result and/or named
   output artifacts. Failed/timed-out work can retain independently accepted
   checkpoints without acquiring a successful metric or promotion claim.
4. Unknown outcomes hold their concurrency slot until an explicit resolution;
   failures do not refund reservations and never trigger an automatic retry.
   Reported over-budget usage is retained truthfully and blocks new reservations.
5. Append-only, digest-linked events preserve original evidence. Duplicate
   operation IDs are idempotent only for identical input; conflicting reuse,
   stale parents, incompatible/unaccepted artifacts and over-allocation fail.
6. Restarted processes reconstruct state from the ledger. Status/tree views can
   be projected through a historical event sequence without revealing subsequent
   outcomes. Accepted comparable metrics, unknowns and diagnostic metrics remain
   distinct. No replay score or researcher-improvement claim is produced.
7. Schemas, privacy scanning, safe repository paths and serialized local writers
   protect ordinary operation; same-user tampering is not an OS trust boundary.
   No old approval, live campaign or competition-specific field is repurposed.

## Intended ownership

OpenCode chooses work and calls the deterministic `dal campaign` interface before
and after execution. DSH performs that bounded task. DAL stores evidence and returns
the current tree, artifact edges, remaining allocation and comparable accepted
incumbent. The task acceptance adapter supplies reviewed evidence digests; the
ledger cannot establish that a claimed test actually ran.

Exploration policy stays fixed within a campaign. A separate optimization process
may later evaluate policies on compatible recorded prefixes and propose a successor
campaign. Applying that successor remains separately human-governed. Artifact-aware
counterfactual cost replay and automatic scheduling are not part of this change.

## Commands and storage

```
dal campaign create --plan plan.json
dal campaign append --operation reserve.json
dal campaign append --operation result.json
dal campaign append --operation review.json
dal campaign tree --campaign experiment-family
dal campaign tree --campaign experiment-family --through 2
```

`create`, `append` and `tree` are additive commands. Historical `campaign prepare`,
`replay` and `status` still use their existing replay-only format and store. The
generic ledger lives at `.dal/artifact-campaigns/<id>/plan.json` and
`events/000001.json`, etc. Its writer lock contains only the local PID. A process
crash may leave that lock: inspect the owner before explicit manual recovery;
there is no automatic lock stealing or execution retry. Events publish atomically
and exclusively; readers validate the entire available chain before projection.
The returned head digest lets the outer harness pin observations. Without an
external head anchor, coordinated rewriting or suffix deletion by the same user
is not detectable as a security attack.

The package exports `@lunarmoon26/dal/campaign` with `prepareArtifactCampaign`,
`appendCampaignOperation`, `artifactCampaignStatus`, and `campaignDigest`.
These functions resolve storage relative to the caller's current workspace and
perform no external execution. Concurrent operations receive `CAMPAIGN_BUSY`;
the caller can retry the same operation id after the writer completes, but must
never interpret that as permission to repeat the underlying experiment.
Append replies bind `sequence`/`head_sha256` to the current journal tip and
`operation_sequence` to the original operation, including on an idempotent retry.

## Adapter obligations and projection

- Root artifacts are supervisor-enrolled inputs with evidence digests. Each
  reservation explicitly includes an accepted workspace artifact. A child's
  starting workspace is its parent's starting snapshot or an accepted workspace
  produced by that parent. Other accepted artifacts can be shared across branches.
- Content identities have one declared producer in this campaign. Reuse belongs
  in `inputs`, not as a new `outputs` claim. Cross-campaign artifacts can be
  enrolled as root inputs in a new frozen plan; they are not automatically trusted.
- Resource units are named integers. Reservations retain their full charge even
  if usage is lower, unknown, failed or timed out. Usage is reported separately;
  a recorded overrun is evidence, not rejected or silently capped accounting.
- `tree` exposes nodes, accepted flags, artifact dependencies through input/output
  references, reservations, in-flight count, overrun state and the best accepted
  metric matching the frozen name/context/direction. Cached diagnostics and full
  streaming measurements need different context identities when not comparable.
- Checksums bind declarations but do not prove dataset eligibility, artifact
  existence, runtime identity, test execution, reviewer authentication or resource
  enforcement. Adapters own those checks and keep blobs/raw traces private.

The complete synthetic fixture sequence is in `tests/fixtures/artifact-campaign/`.
The opt-in [research mechanism foundation](research-mechanisms.md) verifies local
artifact bytes and prepares private requests against these reservations. It does
not change ledger semantics or supply the still adapter-owned execution boundary.
Focused tests in `tests/artifact-campaign.test.ts` cover the criteria above without
DSH, a model, a plugin mount or a competition run.
