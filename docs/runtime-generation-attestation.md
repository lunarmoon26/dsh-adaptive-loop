# Runtime Generation Attestation

Status: DAL contracts, recorder consumer, and controller gate implemented; authoritative DSH producer pending
Change: `chg-runtime-generation-attestation-20260902`
Semantic owner: this document
Exact persisted syntax: [`../schemas/runtime-generation-manifest.v1.schema.json`](../schemas/runtime-generation-manifest.v1.schema.json), [`../schemas/runtime-generation-evidence.v1.schema.json`](../schemas/runtime-generation-evidence.v1.schema.json), [`../schemas/run-record.v1.schema.json`](../schemas/run-record.v1.schema.json), [`../schemas/controller-policy.v1.schema.json`](../schemas/controller-policy.v1.schema.json), and [`../schemas/controller-state.v1.schema.json`](../schemas/controller-state.v1.schema.json)

## Acceptance boundary

This increment:

1. defines a deterministic, closed runtime-generation manifest and separate appraisal evidence;
2. binds a session synchronously to a launcher-owned generation service when that service exists;
3. marks every checkpoint and every session spanning an attempted transition ineligible;
4. keeps legacy `context.harness_sha256` as an independent required controller pin;
5. makes controller enrollment load and validate repository-local evidence and its referenced manifest; and
6. rejects missing, unstable, under-qualified, mismatched, unavailable, or digest-invalid attestations.

It does not claim that current DSH emits authoritative composition, resolver, or artifact evidence. The DAL recorder consumes the service contract without manufacturing that evidence. Until DSH provides the service, ordinary recorder output omits `runtime_generation` and remains controller-ineligible.

## Manifest identity

`runtime-generation-manifest.v1` is an I-JSON document with no timestamp, session identifier, evidence result, or mutable label in its identity. Its digest profile is exactly `rfc8785-jcs-sha256-v1`: SHA-256 over RFC 8785 JSON Canonicalization Scheme bytes.

The manifest binds:

- the launcher artifact;
- a privacy-safe digest of effective validated configuration;
- the ordered Loader tree, including enabled state, resolved package, artifact digest, and per-entry configuration digest;
- ordered resolver receipts; and
- the complete artifact closure.

`configuration.projection_profile` is fixed to `effective-config-jcs-sha256-secret-values-omitted-v1`. Producers must omit secret values before hashing. Raw secrets and unkeyed hashes of secret values are forbidden. Loader and resolver ordinals must be contiguous from zero, referenced URI/digest pairs must exist in the artifact closure, and the artifact closure must be canonically sorted.

## Evidence and assurance

`runtime-generation-evidence.v1` appraises one manifest and one session binding. It contains the manifest URI/digest, producer identity, assurance, the session ID digest, initial and final monotonic transition sequences, a derived stability flag, and bounded evidence references for named claims. The run-record link repeats the session digest so controller enrollment can reject evidence replayed for another recorded session.

Assurance meanings are deliberately distinct:

- `declared`: a producer assertion without observed composition requirements; never accepted by a controller policy;
- `observed`: launcher composition and effective validated configuration were observed; and
- `verified`: observed claims plus resolver and artifact closure were checked.

The `session-binding` claim must pass exactly when initial and final transition sequences match. A rollback does not decrement the sequence, so a session spanning any attempted transition remains unstable even if the prior generation is restored.

## Recorder service seam

The optional Cordis service is named `runtimeGeneration` and implements the structural `RuntimeGenerationSourceLike` contract exported by `@lunarmoon26/dal-run-record`:

```ts
interface RuntimeGenerationSourceLike {
  bindSession(session): RuntimeGenerationBinding | null;
  transitionSequence(): number;
}
```

The launcher must install this service before the recorder. `bindSession` is called synchronously from `session/created`; it must return `null` while a generation transition is in flight. The transition sequence is a non-negative safe integer that only increases, including failed or rolled-back transition attempts. Service replacement/removal makes the binding unstable.

The recorder never late-binds after the first session event. It marks output with `record_stage: checkpoint | final`; intermediate flush records always set `stable_for_session: false`, and controller selection ignores explicit checkpoints. Only a successfully persisted final disposal record can be stable. A malformed or throwing source yields an ordinary run record with no runtime attestation rather than a partial claim; unknown pin properties are rejected rather than copied.

Pinned DSH dispatches `session/disposed` as an observe-only event: it contains rejected listener promises but does not await them. The current adapter therefore cannot prove that its asynchronous final write completes before process teardown. This is an availability limit, not an optimistic identity fallback: a missing final record is ineligible, and checkpoints remain unstable. The upstream producer/lifecycle issue must add an awaited teardown boundary before DAL can claim end-to-end final-record durability.

## Controller enrollment

A controller policy fixes the digest profile and minimum assurance (`observed` or `verified`). Every selected run must:

- retain a non-null legacy harness digest;
- contain `runtime_generation`;
- be stable for the complete session;
- meet the policy assurance and digest profile;
- resolve `evidence_uri` to a canonical `repo://` path;
- match the validated evidence fields;
- bind the same session ID digest as the evidence;
- resolve the evidence's `manifest_uri` to a canonical `repo://` path; and
- match the recomputed RFC 8785 manifest digest.

Evidence and manifest files are read through checked file descriptors; their resolved path must stay under the repository, remain the same unchanged regular file, and never follow a final symbolic link. A platform without native no-follow and non-blocking open flags fails closed. Session binding digests must also be unique within the selected batch. Existing run records without `record_stage` retain historical final-record behavior.

The attestation-bearing controller policy and newly produced controller state use `schema_version: 1.1.0`. Existing `1.0.0` policy/state snapshots still validate under the v1 schemas and cannot carry the new fields. A legacy policy cannot drive a new estimate and fails with `CONTROL_RUNTIME_GENERATION_POLICY_REQUIRED`; it must be explicitly upgraded with a reviewed assurance requirement. This preserves old evidence without silently interpreting it as runtime proof.

All selected runs must then share the same manifest digest and existing prompt/harness/model-patch/harness-pin generation fields. The controller state records the runtime manifest identity but not evidence URIs; immutable input run digests and the controller-policy digest retain the exact appraisal provenance.

## Required upstream DSH work

Verified assurance requires a DSH launcher/Loader producer that owns composition transitions and captures authoritative resolved import URLs, effective post-validation configuration projections, resolver receipts, and artifact bytes. It must install the service during boot preparation, increment its transition sequence before every Loader/HMR mutation attempt, block new bindings until the transition settles, and publish immutable manifest/evidence files. DAL source and synthetic tests do not establish that runtime integration.
