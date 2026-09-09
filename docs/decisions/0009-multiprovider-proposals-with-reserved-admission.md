# 0009: Extend payload-only proposals with reserved admission

Status: Accepted for implementation
Change: `chg-dal-multiprovider-proposals-20260907`
Date: 2026-09-07
Supersedes: the DeepSeek-only route choice in ADR 0008, not its authority boundary

The operator needs automatic proposal generation on OpenAI GPT-5.6 Terra and
Anthropic Sonnet 5 without restoring workspace-enabled DSH execution. Use native
Responses and Messages requests with fixed endpoints and the exact model IDs;
retain the explicit DeepSeek route. No arbitrary endpoint, shell or agent-tool
extension is introduced. Explicit launcher environment loading supplies only
credential references to the transport.

The v2 request owns provider-specific bodies, headers and a budget allocation.
V1 remains unchanged for historical interpretation and cannot authorize v2 sends.
Admission reserves an immutable allocation under a serialized per-budget/provider
ledger after exact approval and before transport. Failed or unknown sends retain
their reservation; duplicate digests cannot trigger another paid request.

This is intentionally conservative about retries but is not a pricing oracle.
Approved reservation units are not guaranteed invoice amounts. DSH rollout
traffic remains outside the proposer ledger; live experiments still need reviewed
prices, a justified worst-case request reservation, and enforcement for every
outbound request. No budget claim extends to other processes or a malicious
local ledger owner.

Offline acceptance: all routes produce validated drafts automatically from
failure clusters; wrong model/provider/approval/budget fail before sending;
OpenAI reasoning envelopes preserve only the assistant answer; tools and
incomplete replies are rejected; concurrent or repeated admissions cannot
inflate the reserved allocation. No live model or candidate activation is
performed by implementation tests.

Owner: [proposer request](../proposer-request.md).
