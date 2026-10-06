# Sonnet 5.5 research pilot gate

Change: `chg-sonnet55-research-gate-20261006`.
User selection: Anthropic `claude-sonnet-5-5`, USD 10 total API allocation for
one Structural Break development pilot, not USD 10 per experiment.

## Accepted foundation and criteria

- Historical OpenAI and Sonnet 5 policies and requests remain unchanged.
- Sonnet 5.5 uses its own pricing profile and exact `between_tools` request mode.
- No omitted/adaptive/manual thinking, fallback, sampling overrides or automatic
  retry is admitted. This initial route accepts text messages only, without tools.
- A Sonnet 5.5 `refusal` is a completed transport response in both JSON and SSE,
  not a successful research outcome. It retains its reservation without retry.
- Every admitted call uses the existing durable shared provider ledger before
  credential access and forwarding. Failed/uncertain calls retain allocations.
- Test schema/model/profile confusion, unsupported shapes, pre-send rejection,
  and concurrent/restarted admission under one USD 10 cap without real calls.

Exact policy fields belong to `e2e-spend-policy.v1`. The new pricing identity is
`reviewed-sonnet55-text-upper-rates-20261006-v1`. Input/output upper rates remain
4/10 micro-USD per token. Official base rates checked on 2026-10-06 are 2/10;
the higher input reservation rate is intentional. Cache controls are rejected.
The existing bound remains `2 * request_bytes + 8192` input tokens plus the full
1,024 output-token allocation. At the 64 KiB maximum this reserves USD 0.567296
per call. These are conditional conservative admission allocations, not invoices,
tax/fee enforcement or an account-global billing limit. The pilot cap is
`provider_limit_microusd: 10000000`, with one budget ID across all pilot calls.

## Compatibility and authority

Anthropic's [Sonnet 5.5 changes](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5)
require `thinking: {"type":"between_tools"}` rather than `disabled`. Without tools,
responses are text-only. With tools, signed progress-update thinking blocks must
be replayed unchanged; this gateway foundation refuses tools until that native
caller path is implemented and independently tested. It does not silently remove
thinking blocks or upgrade existing Sonnet 5 approvals.

The user's go-ahead permits preparing the pilot, not manufacturing an exact
request approval before the outbound artifacts are frozen. The reviewed launcher
must verify a current exact external-transfer approval bound to the frozen
campaign, runtime, gateway policy and allowed payload scope at execution. Source
changes do not install a plugin or mutate any shared/competition profile.

## Real research execution gate

This foundation alone does not run a research agent. The existing Structural Break
worker must consume the verified mechanism/H/task request through a fixed adapter;
provider keys and the ledger stay outside the worker, all outbound model traffic
must traverse the broker, and the frozen evaluator must run independently. The
adapter must pin the development baseline and split/context, finite experiment
and compute limits, allowed artifact roots and exact transfer scope. Holdout tuning,
official submission and canonical-model replacement remain forbidden.

Tool-enabled Sonnet 5.5 caller compatibility and execution/evaluator receipts are
still required before the real workflow can dispatch. The historical tool-free
`dal live` path and direct `dal propose` model allowlists are unchanged. Synthetic
gateway tests are not OpenCode/DSH execution or recursive-improvement evidence.

## Observed local verification

The 16 Sonnet 5.5 gateway tests and 89 historical gateway tests pass without
provider calls. Repository verification passes with 1,349 tests passed and seven
opt-in integration skips. Shared USD 10 accounting is tested across concurrent
gateway instances and restart, retaining failed allocations and refusing replay.
The launcher credential presence check found no designated native Anthropic API
credential; no project environment file or credential value was read. Consequently
no paid request, model proposal or research evaluation ran in this change.

### Subsequent authorized API check

After the user explicitly authorized launcher-only `.env` loading and supplied
the file, a presence-only check confirmed the designated credential. Neither
`.env` nor its values entered output, source control or feedback. One exact
approved text request was sent through the native metered gateway. Anthropic
returned HTTP 200 and 3,575 response bytes, but the gateway classified the response
as `response_incomplete`. The streamed-to-caller JSON connection terminated before
the launcher could recover the provider's stop reason or usage. Do not infer which
stop reason occurred or claim an accepted proposal.

The durable allocation is USD 0.048544 of the USD 10 cap, retained without refund;
USD 9.951456 remains allocated capacity. Actual provider billing is unmeasured.
No retry, fallback, research evaluation, data transfer or model application followed.
The private accounting summary is `.dal/check/sonnet55-pilot/receipt.json`.
The refusal-handling repair has 18 passing new tests plus 89 historical gateway
tests; a refusal is transport completion only, never research acceptance.

### Completion repair and fresh check

`chg-sonnet55-completion-repair-20261007` adds closed-vocabulary stop-reason
diagnostics and validates nonstream JSON before publishing HTTP 200. Incomplete
JSON now yields safe HTTP 502; truncated/paused/unknown replies do not become
accepted output. Streaming stays byte-for-byte and the final observed stop reason
controls validation. The first failed request's actual stop reason remains unknown;
its reservation and failed receipt were neither changed nor replayed.

A distinct exact-approved concise abstract request (`sonnet55-api-check-002`),
using the same budget ledger and USD 10 cap, completed with HTTP 200 and `end_turn`.
Provider-reported usage was 143 input and 204 output tokens, zero cache/thinking
tokens. The second allocation was USD 0.047512; combined retained allocations are
USD 0.096056, leaving USD 9.903944. Actual invoice billing is not measured. Raw
response is workspace-private under the ignored pilot directory; feedback records
contain only safe summaries and references. No training or independent research
evaluation ran, and this does not prove OpenCode/DSH consumption or L4 progress.
Focused gateway suites pass 113 tests, including six new completion regressions.
