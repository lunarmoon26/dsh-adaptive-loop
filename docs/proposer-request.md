# Multi-Provider Proposer Request

Status: Implemented; live-provider execution not verified
Change: `chg-dal-multiprovider-proposals-20260907`
Scope: DAL-015 proposal generation only, not rollout or end-to-end budget confinement.
Exact machine owner: [`../schemas/proposer-request.v2.schema.json`](../schemas/proposer-request.v2.schema.json).
The v1 schema remains unchanged for historical records; v1 approvals do not authorize v2 sends.

## Contract

`prepareChatRequest(payload, model, budget)` returns `{ request, requestJson, requestDigest }`.
The required exported `ProposalBudget` is a plain object containing only
`budget_id`, `provider_limit_microusd`, and `reservation_microusd`. Its identifier
matches `[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}`; amounts are positive safe integers and
reservation cannot exceed the provider limit. The complete budget is digest-bound.
`runPropose` verifies exact approval, rejects an existing draft destination, and
durably reserves budget before calling the internal transport. Transport
validation alone does not prove a reservation exists or authorize sending.

| Provider | Explicit Model | Fixed Endpoint | Selected Credential |
| --- | --- | --- | --- |
| openai | gpt-5.6-terra | https://api.openai.com/v1/responses | OPENAI_API_KEY |
| anthropic | claude-sonnet-5 | https://api.anthropic.com/v1/messages | ANTHROPIC_API_KEY |
| deepseek-official | validated explicit legacy ID | https://api.deepseek.com/chat/completions | DEEPSEEK_API_KEY |

No provider or model fallback exists. OpenAI uses Responses system/user text input,
JSON-object text format, `max_output_tokens: 2048`, `store: false`, and no tools.
Anthropic uses system plus user text, `max_tokens: 2048`, and approved nonsecret
`headers: { "anthropic-version": "2023-06-01" }` metadata. Other routes have empty
protocol headers. OpenAI/DeepSeek use Bearer authorization; Anthropic uses x-api-key.
DeepSeek retains its text-only JSON chat-completions body and explicit model.

The canonical v2 envelope binds schema/version, provider, endpoint, method, content
type, credential designation, protocol headers, budget, body and limits. Send
reconstructs the entire envelope and fails closed on drift before credential access.
Only the selected environment key is read at send; credentials must be nonempty
printable non-whitespace ASCII, at most 512 characters. No `.env` file, profile,
workspace content, tool, subprocess, or URI reference is loaded. Isolated credential
loading via CLI runtime `node --env-file` is explicit, not transport behavior.
`requestModel(request)` and `getRequestPayload(request)` expose route-neutral inputs
for internal integration; they are not validators or authorization checks.

There is one POST, `redirect: error`, no retries, no streaming API response, a
64 KiB complete envelope cap, 128 KiB response cap, and 30 second full-body timeout.
Errors omit credentials, prompts and response bodies. OpenAI requires a completed
response containing exactly one completed assistant message with output_text blocks;
optional reasoning items are discarded, never returned as proposal content.
Anthropic requires an assistant message ending in end_turn containing text blocks.
Tools, refusals, truncation and extra nontext output fail closed. DeepSeek requires
one assistant text choice ending in stop and no tool/function calls. The proposer validates
returned JSON against the proposal contract and privacy-scans drafts before persistence.

## Acceptance Criteria

1. Offline mocks prove exact body, route, auth, protocol headers and one POST for all three providers, with no other environment keys read.
2. Wrong providers/models and absent, nonplain, malformed, unsafe or over-limit budgets fail before sending; each budget field changes request identity.
3. V2 schema and reconstruction reject route/header/body/model/limit/version drift and additional fields; v1 remains historical only.
4. Full-envelope byte caps, response header/stream caps, redirect refusal and full-body timeout fail without retries or sensitive diagnostics.
5. Only complete text-only replies are returned; tools, extra output, refusals and incomplete replies are rejected across routes.
6. Automatic offline runs cover fixture ingestion -> clustering -> preparation -> exact approval -> native-wire mocked transport -> validated persisted draft for both requested models.
7. Missing/expired/wrong approval, exhausted or conflicting ledger, and existing output all prevent sending. Failed sends retain reservations; duplicate request digests cannot send again.

## CLI and workbench

Both `dal propose prepare` and `dal propose run` require `--budget <file>` as well
as `--model`. Select `--provider openai --model gpt-5.6-terra` or
`--provider anthropic --model claude-sonnet-5`; the legacy default provider remains
`deepseek-official`. The budget file contains exactly the three `ProposalBudget`
fields above. Preparation is local and returns a versioned request plus its digest;
run recomputes it and verifies an unexpired approval bound to that exact digest.
Changes to provider, model, data, instructions, or budget require fresh approval.
The deterministic `dal_proposal_prepare` workbench tool accepts provider, model,
and budget-file inputs but still cannot send or approve a model request.

For an explicitly approved send, Node can load repository-local credentials with
`node --env-file=.env dist/cli.js propose run ...`. The transport does not discover
other credential files, and sends only the selected provider's authorization
header. No credentials enter the request manifest or draft.

## Budget scope

The CLI stores durable reservations in `.dal/proposal-budgets`, separated by
budget ID and provider. Immutable cap metadata, exclusive locks, and chained
reservation records serialize admissions. Reusing an ID with a different cap,
corrupt/missing records, abandoned locks, or a repeated request digest fails
closed. Locks after interruption require investigation; there is no automatic
stale-lock recovery or refund. Success, rejection, timeout and unknown outcomes
all retain the reservation. Start a new request only with a freshly reviewed
request identity; do not reset/delete the ledger to bypass a limit.

`budget_reservation` in CLI output reports cumulative reserved and remaining
allocation in microdollars, **not actual provider billing**. Reservation values
are approved allocations, not computed token-price bounds. This ledger protects
only proposer admission under a trusted local store owner; it cannot detect a
wholesale store rollback, concurrent account spending elsewhere, pricing changes,
or control the separate DSH e2e runner's requests. A justified per-request price
upper bound and e2e-wide enforcement are still required before claiming a hard
account-dollar ceiling. This increment does not spend or validate account credits.

## Verification

`tests/propose-transport.test.ts`, `tests/proposal-budget.test.ts`,
`tests/propose.test.ts`, and `tests/propose-automatic.test.ts` exercise wire
formats, approval ordering, ledger integrity, and complete proposal generation
with mocked providers. V1 remains unchanged and registered for historical data;
new sends use v2. Concrete gate results are in `docs/requirement-evidence.md`.
The output is a falsifiable proposal draft, not an applied skill/plugin or an
independently measured improvement. No live-provider or paid e2e proof is claimed.
