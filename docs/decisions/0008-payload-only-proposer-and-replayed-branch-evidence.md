# 0008: Use a payload-only proposer and replay branch evidence

Status: Accepted for implementation
Change: `chg-dal-proposer-receipt-boundary-20260906`
Date: 2026-09-06

## Context

The former proposer approves sanitized payload bytes but launches a complete DSH
headless process in the workspace. That process can load additional instructions,
tools, profile state, and files outside the approved transfer. A temporary working
directory alone does not confine that authority. Generic branch scoring also
trusts stored provenance flags and can count a receipt repeatedly without binding
the actual candidate or full task revision.

## Decision

Use the purpose-specific executor boundary from ADR 0003, but replace its proposer
implementation with one fixed-route DeepSeek HTTPS text request. The approved
versioned envelope names the destination, explicit model, complete message body,
output settings, and transport limits. It provides no tools or workspace access;
the proposer does not invoke DSH or load `.env`. Other providers and a confined
agentic proposer are separate reviewed extensions, not arbitrary endpoint or
subprocess options. The verifier and HMR quarantine are unchanged.

Bind branch artifacts separately from draft and state digests. Replay versioned
evaluation evidence before counting it: task, draft, artifact, receipt, state,
effects and recomputed verdict must still match. Count an execution once across
the archive, independent of receipt ID. Legacy records remain readable but cannot
earn visits without complete proof; existing persisted records are not rewritten.

## Alternatives and consequences

- Retaining headless DSH preserves provider flexibility but exposes an execution
  surface larger than its approval. Rejected for this narrow proposer.
- A sandboxed agent plus credential-isolating proxy supports tool-driven proposal
  work but is a larger deployment boundary. Deferred until actually needed.
- The direct transport loses agentic discovery and requires fresh request-bound
  approval; this is intentional. Generated proposals are hypotheses, not applied
  patches or verified improvements.
- Replaying file-backed receipts detects drift and forged counters, not a hostile
  evaluator owner able to forge the entire evidence chain. Independent execution
  attestation and matched-context comparisons remain separate work.

## Confirmation

Offline mocked-transport tests cover approval ordering, request drift, redirects,
timeouts, oversized and tool-call responses, and sensitive output. Branch tests
cover candidate/task/verdict drift, replay after tampering, duplicate execution,
conflicting reuse, and legacy exclusion. Live model execution requires a separate
exact approval and is not performed by this change.

Focused owners: [proposer request](../proposer-request.md) and
[branch evidence](../branch-evidence.md).
