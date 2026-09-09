# Paid Campaign Preflight

Change: `chg-dal-paid-e2e-preflight-20260907`.
Machine owner: exported interfaces and regeneration validator in
`benchmarks/tau-style-workflow/prepare-paid-campaign.ts`. No shared schema changes.

## Contract

The keyless planner prepares exactly two phase-1 baseline attempts: OpenAI
`gpt-5.6-terra` with a 6,000,000 micro-USD campaign/provider cap, and Anthropic
`claude-sonnet-5` with a 5,000,000 cap. Both use `task-001-refund.json` once,
the same policy, skill, prompts, image and source identities. These are caps,
not planned spending, verified pricing, measured billing or improvement claims.
Every gateway policy uses the campaign as budget ID; never reset a ledger or
allocate a new ID to evade cumulative caps.

The emitted gateway policies carry the pricing and token-bound profiles and
their numeric assumptions: `(2 * charged_body_bytes + 8192) * input_rate +
1024 * output_rate`, with input/output micro-USD per token of 5/18 for OpenAI
and 4/10 for Anthropic. These are experimental upper-bound assumptions requiring
review, not provider-price verification. Charged bytes are the larger of wire
and canonical JSON bytes. Policies also bind request/response
byte limits and timeout. No balance or pricing endpoint is queried.

An explicit local image tag (not `latest`) or SHA-256 digest and campaign ID
are mandatory. The existing manifest helper hashes task/policy/skill/prompt,
driver and executed gateway/plugin sources. It inspects the local image and
runs network-disabled digest probes by immutable image ID. It does not build
or pull images. The planner never invokes the e2e runner CLI, reads provider
credentials or `.env`, accesses providers, approves a request or launches DSH.
An explicit image prevents the helper's environment-image fallback.

Output must be a new direct child of an existing real directory below the
repository's `.dal/check`. Symlinks, existing destinations, noncanonical paths,
unknown/duplicate CLI flags and missing arguments fail closed. Directories are
0700 and files 0600 with exclusive creation. Partial output after failure must
not be reused. Local transmission files contain only the helper's necessary
manifest content, including benchmark prompts; campaign metadata references
these files and digests, not transcripts or environment values. Do not commit
these private artifacts.

`approval-request-v1` is a local pending-request contract, **not** an
`approval-decision.v1` object: that existing schema only permits approved or
rejected human decisions. Requests bind the exact manifest digest and reserved
decision ID, with `status: pending`, `reviewer: null` and `authorized: false`.
The planner cannot manufacture reviewer identity, decision time or expiry.
A human decision must separately satisfy the existing schema and runner checks.

## Commands

From the DAL repository root, with an already-built derived image and existing
`.dal/check` parent (replace the example image with its exact local identity):

```sh
pnpm exec tsx benchmarks/tau-style-workflow/prepare-paid-campaign.ts --image dal-derived:reviewed-v1 --campaign paid-preflight-001 --output .dal/check/paid-preflight-001
pnpm exec tsx benchmarks/tau-style-workflow/prepare-paid-campaign.ts --verify .dal/check/paid-preflight-001 --image dal-derived:reviewed-v1 --campaign paid-preflight-001
```

The artifact includes exact runner preparation argv for each provider:
`--mode live --campaign ... --batch ... --provider ... --model ...
--provider-cap-microusd ... --approval-id ... --image ...
--tasks task-001-refund.json --attempts 1 --prepare true --manifest ...`.
The manifest destination in that argv is a **new** runner-export path, not an
existing planner file. These commands only prepare; the planner does not run
them. Live execution requires removal of both preparation flags and a separate
exact approved, unexpired decision via the runner's `--approval` option.
Do not start paid execution until the integrating keyless DSH rehearsal and
budget/gateway/proposer handoff prerequisites have actually passed.

Verification re-derives every manifest using the supplied image and campaign,
rehashes the planner source, and compares canonical JSON for every file and the
exact directory inventory. It rejects task, model, cap, image, source, prompt,
policy, approval-state and metadata drift. It is a freshness check, not a
signature or protection against a malicious local owner replacing code and
artifacts together. Do not place runner exports or human decisions inside this
immutable artifact directory.

## Proposal Boundary

The campaign uses the [metered proposal handoff](metered-proposal.md), not direct
`dal propose run`. Phase 2 awaits resulting sanitized phase-1 evidence. It
constructs one exact metered proposal manifest per provider from that evidence,
with manifest-digest-specific human approval and the same canonical ledger,
campaign ID and provider cap. A candidate evaluation
requires its own exact manifest and approval after candidate bytes exist.
No future candidate, request digest, success result or live benchmark benefit
is fabricated here. The planner itself does not run those stages. Actual keyless
DSH and same-ledger proposal rehearsal evidence is recorded in
`docs/requirement-evidence.md`; it does not imply measured adaptation benefit.

## Acceptance and Evidence

`tests/paid-campaign-preflight.test.ts` covers exact finite scope, pending-only
requests, regeneration and tamper rejection, exclusive private output and
strict CLI validation using an internal injected manifest resolver. A filesystem-backed
regression test reads the selected repository task fixture, checks its task ID,
and validates the hyphenated filename through the current run-ID and policy helpers. Unit tests
need no Docker, credentials, model calls or approval execution. Real derived
image preparation and agent-runner rehearsal are separate integration evidence.
