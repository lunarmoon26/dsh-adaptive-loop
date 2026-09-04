# 0005: Separate runtime generation identity from appraisal evidence

Status: Accepted
Date: 2026-09-02
Related: [`../runtime-generation-attestation.md`](../runtime-generation-attestation.md), [`../architecture.md`](../architecture.md), [`../control-governed-evolution.md`](../control-governed-evolution.md)

## Context

Controller observation previously treated a declared harness digest plus prompt/model-patch/artifact pins as one generation. Those fields do not prove which Cordis Loader tree, effective validated configuration, resolved modules, or bytes actually served a session. They also cannot show that a session remained on one generation while Loader/HMR mutation and rollback were possible.

Runtime identity must remain deterministic and privacy-safe, while evidence quality and per-session stability can change without changing the composed generation. Current DSH does not expose all authoritative inputs, so DAL must not manufacture verified assurance from session events or static configuration.

## Decision drivers

- Fail closed rather than enroll runs from self-declared or transition-spanning generations.
- Preserve existing run records and the independent `context.harness_sha256` meaning.
- Keep secrets and unkeyed secret hashes out of persisted identity.
- Make identity portable and deterministic across JSON producers.
- Leave composition and mutation ownership with the DSH launcher/Loader.
- Permit stronger evidence later without changing manifest identity.

## Options considered

### Continue using only the declared harness digest

- Helps by preserving the smallest record shape.
- Hurts because declarations cannot prove effective composition, resolution, or session stability.

### Hash static profile and source files in the recorder

- Helps by requiring no DSH change.
- Hurts because the recorder sees neither authoritative resolution nor post-validation configuration and can race dynamic mutation; it would overstate observed files as runtime proof.

### Canonical manifest plus separate evidence and launcher-owned binding

- Helps by separating stable identity from assurance and session appraisal.
- Helps by placing transition sequencing and resolver/config capture at their owning boundary.
- Hurts because verified records require an upstream DSH producer and older/unattested records cannot enter controller batches.

## Decision

Use a closed I-JSON runtime manifest identified by SHA-256 over RFC 8785 JCS bytes. The manifest binds launcher, secret-omitting effective-config projection, ordered Loader tree, resolver receipts, and artifact closure. Store declared/observed/verified assurance and monotonic per-session transition evidence in a separate record.

The run recorder consumes an optional launcher-owned `runtimeGeneration` service synchronously at `session/created`; it does not infer or late-bind identity. Controller policy chooses a minimum observed/verified assurance. Enrollment loads repository-local evidence and its manifest through checked descriptors, validates and recomputes their binding, requires unique whole-session bindings, and retains the legacy harness digest as a separate pin. New controller policies/states use schema version 1.1; version 1.0 snapshots remain valid but cannot be interpreted as attested or drive a new estimate.

## Consequences

- Positive: equal manifest digests mean equal contracted runtime composition rather than equal labels.
- Positive: appraisal can strengthen or fail without changing generation identity.
- Positive: rollback attempts remain observable because transition sequence never decreases.
- Negative: existing and ordinary recorder records remain controller-ineligible until evidence is supplied.
- Negative: repository-local evidence availability becomes part of offline controller estimation.
- Neutral: historical controller snapshots remain readable and require an explicit policy upgrade before new estimation.
- Neutral: authoritative manifest production, readiness, mutation blocking, and immutable publication remain upstream DSH work.

## Confirmation

- Contract tests cover JCS identity, duplicate names, artifact closure, evidence claims, and manifest binding.
- Recorder tests cover creation-time binding, unstable checkpoints, transition attempts, and Cordis event wiring.
- Controller tests cover missing, unstable, downgraded, mixed, unavailable, and forged evidence.
- No integration claim is made until the pinned DSH launcher/Loader producer is executed.

## Links

- Refines [`0004-separate-run-to-run-supervisor.md`](0004-separate-run-to-run-supervisor.md); it does not change the controller's observation-only authority.
