# Live promotion control

Status: Accepted
Change: `chg-dal-hitl-promotion-control-20260927`
Semantic owner: this document
Exact persisted syntax: [`../schemas/live-state.v1.schema.json`](../schemas/live-state.v1.schema.json),
[`../schemas/live-review.v1.schema.json`](../schemas/live-review.v1.schema.json),
[`../schemas/live-dream.v1.schema.json`](../schemas/live-dream.v1.schema.json),
and [`../schemas/approval-decision.v1.schema.json`](../schemas/approval-decision.v1.schema.json)

## Boundary

The outer agent executes tasks against the workspace-local active generation. It
does not propose, score, approve or switch generations. DSH and DAL form an
inner evolution harness: they build bounded text candidates and verify fixed
local evidence, but cannot self-promote. The independent evaluator, human
reviewer and DAL promotion executor remain separate responsibilities.

This contract covers only content-addressed prompt/skill text. It does not
authorize profile edits, plugin mounting, executable candidates, HMR admission,
shared configuration, evaluator changes, holdout changes or model-controlled
file access.

The fixed exploration policy that creates a discovery tree is part of the frozen
campaign plan, not this promotion decision. `dal live dream` can compare bounded
policies against compatible stored prefix-only tree outcomes, but its result has no
pointer write or activation authority. A reviewer may use that immutable evidence
when approving the next plan; it cannot alter the active rollout or candidate review.

## Lifecycle

```text
prepared -> baseline -> search -> complete
                              \
                               -> awaiting_review -> probe -> complete
                                                    \-> rolled_back
                               -> rejected
```

`search` evaluates candidate text and computes strict qualification eligibility.
If no candidate qualifies, `complete` retains the incumbent. If one qualifies,
DAL writes a review request and records `awaiting_review`; the active pointer is
unchanged. A rejection is terminal for the campaign and leaves that pointer
unchanged.

An approval transitions only through the purpose-specific promotion executor.
It revalidates the plan, runtime, campaign grant, mount decision, review request
and exact human approval before switching the pointer. It then runs the fixed
canary. A passing canary retains the candidate; a failed canary restores the
exact prior generation. A crash or unknown native operation is never retried.

## Review bundle and authority

The immutable review request includes:

- plan digest, pre-review state digest and deterministic evaluation digest;
- incumbent and candidate generation digests;
- exact promotion scope containing all of those identities.

The existing `approval-decision.v1` document must be `approved` or `rejected`,
name `apply_optimization_candidate`, bind the exact review scope and candidate,
and be current when verified. A decision receipt binds the source decision digest
and reviewer identity into campaign history. The JSON decision is a local human
attestation. It is not an authentication protocol, a digital signature, or proof
of reviewer identity.

The campaign grant independently authorizes only bounded native calls,
activation and rollback. It cannot substitute for the candidate-specific human
decision. A scorecard, dashboard, model response, Cordis event or grant cannot
substitute for either authority record.

## Dashboard

`dal live review --campaign <id> [--port <port>]` starts a loopback-only DAL
dashboard. It is a local read model: it shows candidate and incumbent text,
safe BPE evidence, deterministic score summaries, review scope and the request
download. It serves no write endpoints. The page cannot create a decision,
perform promotion or rollback, invoke a model, access credentials, mount a
plugin or alter a profile.

The reviewer creates the human decision out of band, then uses:

```text
dal live promote --campaign <id> --grant <grant> --mount-approval <approval> --approval <decision>
dal live reject --campaign <id> --approval <decision>
```

The dashboard never becomes a model tool. A Cordis plugin may later render this
same projection only as an approved, disabled-by-default view adapter; it cannot
be the decision issuer or pointer writer.

## Acceptance criteria

1. An eligible candidate reaches `awaiting_review` with the incumbent still
   active; re-running the campaign does not activate it.
2. Promotion rejects absent, rejected, expired, wrong-scope, wrong-candidate or
   drifted review decisions before the pointer changes.
3. An approved exact decision records an immutable receipt, activates only the
   staged candidate and retains it only after the deterministic canary passes.
4. A failed canary compensates to the exact incumbent without a native resend.
5. A rejected exact decision is immutable, terminal and leaves the incumbent
   active.
6. The loopback dashboard contains no write route or model/tool capability and
   never renders expected answers, raw replies, credential references or
   qualification/canary inputs.
7. The proposal-facing BPE view remains development-scoped; the dashboard BPE
   view is digest-only.
8. Dream replay uses only stored discovery nodes and the shared batch interface;
   it makes no model/evaluator/native call and cannot redeploy a policy itself.
