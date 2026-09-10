# Explicit Anthropic Off

Change: `chg-dal-anthropic-off-20260910`
Status: Implemented and keyless-runtime verified; no paid execution authorized

The inspected DSH/pi-ai stack supports both thinking and non-thinking Sonnet 5.
`reasoningEfforts: false` changes model capability metadata; it does not send an
API disable instruction. Preserve the stock Sonnet descriptor and select
`reasoning: off`, which serializes to `thinking: {type: "disabled"}`.

Acceptance:
1. Anthropic DSH composition explicitly selects Off and does not override the
   model's reasoning capability to false. OpenAI composition remains unchanged.
2. The text-budgeted gateway requires exactly `thinking: {type: "disabled"}` for
   Anthropic. Omission, adaptive/enabled modes, extra fields and thinking replay
   remain rejected before reservation or transport.
3. Direct and metered Anthropic proposals send the same explicit disable. New
   direct Anthropic requests use v3; historical v1/v2 schemas remain unchanged,
   and OpenAI/DeepSeek request identities do not change.
4. Native serializer capture and an actual keyless DSH rehearsal verify the
   emitted instruction, not just configuration strings. The gateway remains the
   admission authority and budget/approval controls are not weakened.
5. All affected tests and the full local gate pass. Old paid receipts, claims and
   reservations remain untouched; new source/image scopes require fresh approval.

This fixes a proven mode-selection defect, not the unclassified historical
Anthropic HTTP 400. Supporting thinking-enabled evaluation remains a separate
gateway/replay/accounting change; no DSH provider fork is needed for Off.

Actual keyless DSH execution on the rebuilt image completed two gateway requests
and a successful tool call followed by `DONE`. Because gateway admission now
requires explicit disabled thinking before reservation, this verifies native
wire behavior, not just the YAML string. The intentional no-op fixture fails
the refund oracle, independently of protocol success. Direct and metered
proposal tests also pass with explicit Off. Full gate results and immutable
feedback are recorded in `docs/requirement-evidence.md`.
