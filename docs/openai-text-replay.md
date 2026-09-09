# OpenAI text-only replay repair

Change: `chg-dal-live-gateway-repair-20260908`
Status: Implemented and keyless-runtime verified; no paid retry authorized

Offline native SDK reconstruction of the saved failed run produced a 40211-byte
second request with an encrypted reasoning item, a complete function call, and
inline tool output. It fails the gateway's OpenAI input guard. Removing only the
reasoning item produces a 38680-byte admitted request. No historical wire body
was retained; this is a reconstruction using saved evidence and the pinned SDK.

The caller-side adapter declares a text-only Responses replay profile, loaded
only in the isolated DSH process and bound into the image/source manifest. It
sets explicit `reasoning.effort: none`; the previous `reasoningEfforts: false`
catalog setting omitted that wire control instead of disabling it at the API.

Acceptance:
- For the fixed gateway Responses route and exact Terra model, discard only
  reasoning items whose visible summary/content are absent or empty arrays.
  Nonempty visible reasoning and unknown metadata fail closed, not silently lost.
- Remove the optional native function item ID when discarding paired reasoning,
  but preserve `call_id`, tool names, arguments, outputs and visible messages.
- Never pass ciphertext/reference-only reasoning through the gateway. Gateway
  admission remains restrictive; accounting applies to the actual projected wire
  request. This explicitly changes representation, not the selected model.
- Other endpoints and Anthropic calls pass through unchanged. Bound request bytes
  and fixed diagnostics contain no request text or ciphertext.
- Synthetic reasoning-plus-tool replay succeeds through the real pinned DSH
  runtime and local gateway. Live provider acceptance is not inferred from this
  keyless proof and requires a fresh exact manifest approval.

Gateway failures also preserve bounded, allowlisted guard/stage and upstream HTTP
status diagnostics. Original Anthropic failure remains unknown; no new diagnosis
is retroactively invented. Original approvals, reservations and failed run claims
are immutable and are not reused for a paid retry.

Verification: native keyless DSH processed an OpenAI response containing empty
encrypted reasoning plus a function call, replayed the complete tool result,
and finished through the projected route with two completed gateway requests and
zero rejections. The corresponding Anthropic rehearsal also passed. The mocked
refund oracle still fails intentionally; this is protocol proof, not task quality.
Pure projection, fetch-wrapper, diagnostic schema, poisoned error metadata and
bounded receipt tests are retained in the repository. Live API acceptance of the
projected history remains unverified until a separately approved retry.
