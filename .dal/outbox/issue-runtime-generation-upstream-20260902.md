## Problem

DAL now has closed runtime-generation manifest/evidence contracts, a recorder consumer, and a fail-closed controller verifier. The pinned DSH runtime (`@deepseek-ai/dsh@0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) does not expose the authoritative launcher/Loader state needed to produce that evidence.

It also dispatches `session/disposed` as an observe-only event: asynchronous listener completion is contained but not awaited. A recorder can therefore persist awaited checkpoints, but cannot prove its final session record completed before process teardown.

## Required upstream seam

- Install a launcher/Loader-owned `runtimeGeneration` service before recorder `session/created` listeners run.
- Return a precomputed session binding only while one settled generation is active; reject or return no binding during a transition.
- Produce a closed manifest binding the launcher artifact, secret-omitting effective validated configuration, ordered Loader tree, resolver receipts, and complete artifact closure.
- Compute manifest identity as SHA-256 over RFC 8785 JCS bytes using `rfc8785-jcs-sha256-v1`.
- Increment a monotonic transition sequence before every Loader/HMR mutation attempt, including attempts that fail or roll back; never decrement it.
- Publish immutable per-session evidence with the bound/final transition sequence, session ID digest, assurance, and claim references.
- Add an awaited teardown durability boundary so persistence listeners can complete a final record before the session/process is released.

The consumer-side contract is documented in `docs/runtime-generation-attestation.md`; exact fields are in `schemas/runtime-generation-manifest.v1.schema.json` and `schemas/runtime-generation-evidence.v1.schema.json`.

## Acceptance evidence

1. Two cold starts with identical launcher, effective configuration, Loader composition, resolver results, and artifact bytes produce the same manifest digest.
2. A change to effective configuration or Loader enabled/config state changes the digest without exposing secret values.
3. A resolved URL or artifact-byte change updates the resolver/artifact closure and changes the digest.
4. New session binding is unavailable during a successful transition; the sequence increments and later sessions bind the new generation.
5. A failed or rolled-back transition still increments the sequence, and a session spanning the attempt is marked unstable.
6. Teardown waits for final persistence; a completed stable session has one durable final record, while missing evidence, interrupted finalization, and transition-spanning sessions remain controller-ineligible.

## Boundaries

This is an upstream tracking issue only. It does not authorize changing shared DSH profiles, mounting a plugin, sending runtime/project data to a model, applying an optimization candidate, or claiming current end-to-end DSH integration proof.
