# E2E Spend Gateway

Change: `chg-dal-paid-e2e-preflight-20260907`.
Machine owner: [`e2e-spend-policy.v1.schema.json`](../schemas/e2e-spend-policy.v1.schema.json).
Implementation: [`src/e2e-model-gateway.ts`](../src/e2e-model-gateway.ts).
Scope: bounded, pre-paid experiment infrastructure. This component does not authorize a campaign, establish Docker isolation, or prove workflow success.

## Acceptance Criteria

1. Unauthorized paths, models, identities and unsupported input shapes cannot reserve or invoke upstream transport.
2. Each admitted request durably reserves a conservative full cost before credential access and transport; failures, retries and concurrent requests cannot exceed an explicit provider campaign cap.
3. Native SSE passes through byte-for-byte, with continuous response-size, deadline and caller-disconnect bounds. Nonstream JSON works for a proposer.
4. Receipts replay the canonical ledger and fail closed on corruption. Safe outcome summaries contain no request, response, tool argument, credential or provider error content.
5. Keyless rehearsal produces both provider protocols without invoking an upstream network transport. Mock/loopback tests make no provider calls and read no `.env` files.

## Diagnostic Repair Contract

Change: `chg-dal-live-gateway-repair-20260908`. Accepted before implementation.

1. Protected `/receipt` adds `failure_diagnostics: { records, dropped_count }`. Each record passes exported `validateGatewayFailure(value)` (assertion, throws a fixed error); the exact closed shape is owned by `schemas/gateway-failure.v1.schema.json`. Legacy receipts without the field remain a caller integration concern.
2. Records contain only fixed stage/local code, observed integer HTTP status or null, reservation boolean, and allowlisted provider type/code or null. No raw message, body, header, URL, prompt, arguments, ciphertext, key, stack, or arbitrary error code is persisted or returned. Public health and unauthenticated errors never expose diagnostics.
3. Stages cover auth, request, admission, reservation, credential, upstream, response, persistence and cancel. Codes distinguish reasoning/references, budget/replay, missing credentials, network errors, HTTP rejection, timeout/disconnect, MIME, response overflow and missing SSE terminal. Admission and encrypted/reasoning denial remain unchanged.
4. Non-OK status is captured before rejection. At most 8 KiB of error-body bytes are retained ephemerally under the original deadline, solely to extract exact allowlisted provider type/code. Malformed/oversized JSON and hostile codes yield null, never raw fallback.
5. At most 32 immutable diagnostic records and one overflow marker are stored per budget/provider/campaign/run, independently of reservation success. Exclusive slot creation prevents same-run overwrite across processes/restarts. `dropped_count` counts process-observed drops (saturating safe integer); after restart the overflow marker supplies a conservative lower bound of one, not an exact historical count. No refund or historical ledger/outcome mutation occurs. Persistence failure denies new admission but leaves authenticated receipt available when the ledger is readable.
6. Offline fake-upstream tests cover status 401/400/429, malicious codes, malformed JSON, network secrets, credential absence with a substituted environment, timeout/disconnect, oversize, pre-budget rejection, reasoning denial, replay/budget denial, restart durability, finite storage and hostile validation. No paid calls, real environment credentials, Docker proof or caller/preload changes are included.

## Trust Boundary

Anthropic text-mode admission requires exactly `thinking: {type: "disabled"}`.
Omission is not accepted because Sonnet 5 defaults to adaptive thinking at the
API. The DSH profile selects `reasoning: off` while retaining the native model
capability; it does not set `reasoningEfforts: false`. Adaptive/manual thinking,
extra thinking fields and signed thinking replay remain outside this gateway
profile. This admission change and direct proposal v3 require fresh exact
approvals; see [explicit Anthropic Off](anthropic-off.md).

The trusted launcher verifies the exact unexpired external-transfer approval and its manifest immediately before launch. It binds the complete policy, candidate/proposer execution identity, provider/model, image and gateway source digest, task/proposal identity, composition and network topology. **A policy file or `approval_id` is not approval verification.** The gateway accepts this launcher-owned policy and never accepts policy overrides through HTTP.

One gateway serves one launcher-authorized `run_id` and one provider. Its random per-run capability authenticates that identity; the HTTP client cannot choose another run or campaign. The launcher must not reuse capabilities between attempts or expose one attempt's endpoint to another. The manifest maps `run_id` to the exact execution/task or proposer request; there are no additional client-selectable identity headers.

The candidate container joins only an internal candidate-facing Docker network. It has no outbound network, host networking, Docker socket, real provider keys, host credential mounts, or ledger mounts. Only the gateway joins both that internal network and a separate outbound network. Other internal services must not proxy arbitrary internet requests. The gateway alone receives its designated provider key and a writable shared volume at `/gateway-ledger`. Use a trusted, persistent local volume, the same `budget_id` across every candidate and proposer call in the campaign, and the same provider cap. Never reset it between attempts. Rehearsal uses a separate ledger volume/budget from live operation. Main runner/topology integration owns enforcement and Docker proof; this module alone cannot prevent bypassing the broker.

## API

`startGateway({ policy, ledgerRoot, token, mode, upstream?, host?, port? })` returns `Promise<{ address: string, close(): Promise<void> }>`. The default listener is loopback on an ephemeral port. Docker uses `host: "0.0.0.0"`, `port: 8787`. `address` is an HTTP origin. `close()` aborts active transport and awaits pending outcome persistence. `ledgerRoot` must be an absolute canonical real-directory path without symlink ancestors; macOS tests resolve the temporary root first.

- `GET /health`: public readiness only, no credentials or configuration values. Healthy response is `{"ready":true}`. Evidence persistence failures deny health and further admissions; authenticated receipt remains available if its evidence can be read safely.
- `GET /receipt`: capability-protected JSON with campaign/run/provider/mode, durable `reservations` and `reserved_microusd`, and bounded-field `process_counts` (`completed`, `failed`, `rejected`, `response_bytes`). Process counters reset on restart; ledger totals do not. Concurrent ledger locks and corrupt/incomplete records yield an error, never an invented zero total. A never-initialized ledger is zero.
- `POST /v1/responses`: OpenAI gateway only, exact model `gpt-5.6-terra`.
- `POST /v1/messages`: Anthropic gateway only, exact model `claude-sonnet-5`.

Authentication accepts `Authorization: Bearer <capability>` or Anthropic-style `x-api-key: <capability>`. A supplied Authorization header takes precedence. Token length is at least 32 non-whitespace characters; the launcher generates a cryptographically random token. Authentication compares fixed-length SHA-256 digests with `timingSafeEqual`. The capability never becomes an upstream header. All refusals have a fixed safe JSON error (400 before reservation; 502 after reservation); if response bytes were already sent, the connection is terminated. No raw transport exceptions are logged or returned.

`GatewayUpstream` is a trusted in-process test seam `(url: string, init: RequestInit) => Promise<Response>`. In live mode, an injected transport suppresses credential reads; it is never configurable over HTTP or standalone environment. Production omits it and uses native `fetch`. Rehearsal rejects injection entirely, so its built-in responder never opens outbound sockets. `createRehearsalUpstream()` exports the deterministic responder for protocol tests or trusted fixture extension. It emits a first `get_order({order_id: "ord-1001"})` call and subsequent `DONE` responses, with OpenAI function-call events or Anthropic tool-use events. This fixture does **not** interpret workflow results or prove the workflow oracle passes; main may refine its deterministic sequence for actual keyless DSH rehearsal.

## Standalone Environment

The compiled entrypoint is `node dist/e2e-model-gateway.js`; the source equivalent is `pnpm exec tsx src/e2e-model-gateway.ts`. It listens on `0.0.0.0:8787`.

| Environment Name | Contract |
| --- | --- |
| `DAL_GATEWAY_POLICY` | Required path to trusted JSON matching the schema; no dotenv loader, explicit `.env` path names rejected. |
| `DAL_GATEWAY_MODE` | Required, exactly `live` or `rehearsal`; no live default. |
| `DAL_GATEWAY_TOKEN` | Required per-run gateway capability; candidate gets only this capability through its provider configuration environment. |
| `DAL_GATEWAY_LEDGER_ROOT` | Trusted persistent ledger path; standalone default `/gateway-ledger`. |
| `OPENAI_API_KEY` | Read only for live OpenAI, after reservation, and only without injected transport. |
| `ANTHROPIC_API_KEY` | Read only for live Anthropic, after reservation, and only without injected transport. |

No `.env` file is loaded. No other provider key is read. The launcher must never pass real keys to the candidate or print resolved environment values. SIGINT/SIGTERM close the listener and abort active requests. Startup errors print only `Gateway startup failed`.

## Policy And Admission

All policy fields are required, with no implicit cap. Exact identities are `schema_version`, `campaign_id`, `budget_id`, `approval_id`, `run_id`, `provider`, and `model`. User-approved caps are explicitly supplied as `provider_limit_microusd`: OpenAI `6000000`, Anthropic `5000000` for this campaign. The schema allows other explicit positive safe-integer caps for separate approvals and small tests, not silent default budgets.

Fixed manifest-bound constants are `max_request_bytes: 65536`, `max_response_bytes: 2097152`, `timeout_ms: 120000`, `max_output_tokens: 1024`, `pricing_profile: "reviewed-text-upper-rates-20260907-v1"`, and `token_bound_profile: "json-bytes-times-two-plus-8192-v1"`. OpenAI input/output rates are `5`/`18` micro-USD per token; Anthropic rates are `4`/`10`. Provider/model/rate mismatches fail validation. Changing a limit or pricing profile requires a reviewed code/schema change and fresh manifest approval, not an HTTP override.

The gateway counts actual streamed request bytes before JSON parsing, including chunked uploads, and rejects compressed bodies. It accepts only UTF-8 JSON and rejects unknown top-level keys. Native `max_output_tokens` or `max_tokens` is required as a positive integer at most 1024; overshoot is rejected, never silently normalized. Both `stream: true` and false/omitted are supported. OpenAI requires explicit `store: false`.

Supported inputs are inline strings, inline text message blocks, complete custom function-call arguments, and inline text tool results. Custom tools use OpenAI `type: "function"` with `parameters`, or Anthropic `name` with `input_schema`; optional descriptions and the provider's supported tool-choice controls are admitted. Tool schemas may use local fragment references, not remote `$ref`/dynamic/recursive references. Temperature/top-p are bounded numeric options. Anthropic text system blocks and text stop sequences are supported. The allowlist deliberately excludes OpenAI reasoning-item replay and unsupported SDK extensions; callers must construct the admitted native shapes rather than forward opaque stored items.

Media blocks, remote input URLs, file IDs, item references, `previous_response_id`, conversations/containers, background/batch/priority modes, provider built-in tools, cache controls and unrecognized fields fail before reservation. URLs appearing inside ordinary text/tool-result strings are inert charged text, not remote fetch instructions; there is no general ban on mentioning a URL in text. Only the two fixed HTTPS endpoints receive provider credentials; redirects are errors, incoming headers are not relayed, and there are no retries.

## Reservation Argument

For `B`, the larger of actual admitted request bytes and canonical JSON bytes
(both at most 65536, including numeric rendering expansion):

```text
upper_input_tokens = 2 * B + 8192
reservation_microusd = upper_input_tokens * input_microusd_per_token
                    + 1024 * output_microusd_per_token
```

This deliberately reserves the full 1024 output tokens even if a request asks for less. At the 64 KiB request ceiling, upper input is 139264 tokens and input plus output is 140288, below 200000. The bound includes complete JSON/tool-schema overhead and the explicit framing allowance, not a lossy prompt substring or character count. Rates are the user-specified reviewed experimental maxima: OpenAI input 5/output 18 (including the asserted published long-context/cache-write maxima); Anthropic input 4/output 10 (including the asserted one-hour Sonnet cache-write maximum). Reference locations supplied for review are [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). This change does not independently fetch or attest current pricing; renewed approval must review these assumptions if provider terms change.

**The hard admission claim is conditional on this explicit text-token upper-bound and pricing assumption.** It is not measured billing, account-global enforcement, taxes, fees, currency conversion, other API clients, or a guarantee against provider pricing changes. No successful, failed, timed-out, cancelled, or uncertain call refunds its reservation in this experiment. Unused reservations remain charged to the admission cap. Optional provider usage is not used to reduce allocations.

`reserveProposalBudget` stores the existing canonical hash-chained cap/reservations under `<ledgerRoot>/<budget_id>/<provider>/`. It atomically excludes concurrent writers, refuses cap drift, duplicate request digests, corruption and insufficient budget. The digest binds launcher-authorized campaign, run, provider and the complete canonical admitted JSON. Whitespace/key-order-only retries are also duplicates; a new approval does not authorize replay of the same request. A busy lock fails immediately without waiting/retrying. Unknown outcome requires human investigation, not automatic lock removal or ledger reset.

The ledger is locally trusted, not a defense against a filesystem owner deleting or rolling back the whole volume. Losing the entire ledger cannot be distinguished from a never-initialized store by a new process. Both launchers enforce the same canonical repository `.dal/check/spend` root; alternate roots are rejected. Persistent volume integrity and independent campaign provenance remain operator responsibilities.

## Response Evidence

The AbortController deadline starts with the inbound request and covers body read, fetch, all response reads and backpressure. Caller disconnect and shutdown abort transport. Response byte counting is continuous, independent of Content-Length; at most 2 MiB passes through. Only content-type plus fixed no-store/proxy-buffering headers are returned. SSE bytes are unchanged; bounded ephemeral parsing checks for a terminal provider event and explicit failure events, without persisting raw data. Nonstream JSON must have a completed OpenAI status or recognized Anthropic terminal reason. Truncation/error closes the connection and increments failure counts without refund.

Each reserved request writes one exclusive, fsynced digest-named summary in `<ledgerRoot>/gateway-outcomes/` with campaign/run/provider, request digest, mode, `completed` or `failed_or_partial`, bounded response bytes, and the no-refund accounting label. It contains no body or usage transcript. A missing summary after crash is an unknown outcome, not unspent budget. Summary write failures make the process unhealthy and deny subsequent admissions. Durable reservations remain authoritative even when no response or summary survives.

## Verification

Focused commands (keyless, no provider calls):

```sh
pnpm exec vitest run tests/e2e-model-gateway.test.ts
pnpm exec vitest run tests/e2e-model-gateway.test.ts tests/proposal-budget.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
```

Tests cover both schemas/rate combinations, explicit integer caps, unsafe request families, wrong routes/auth, actual chunked body limits, numeric expansion, reservation-before-transport, concurrent shared caps, canonical retry denial, provider errors, native SSE passthrough, nonstream/rehearsal fixtures, response overflow, disconnect, full-stream timeout, partial-response summaries, receipt restart and corruption. Unit tests do not establish paid-provider billing. Actual keyless Docker/DSH and proposal-handoff evidence is recorded in `docs/requirement-evidence.md`.

Historical preflight verification: 49 gateway tests and 44 reservation-ledger tests passed (93 total).

Diagnostic repair verification (2026-09-08): 82 gateway tests and 44 reservation-ledger tests pass (126 total); repository TypeScript `--noEmit` check passes. These focused offline checks are the acceptance evidence. No paid requests, real provider credential reads, `.env` reads, Docker integration runs, or edits outside the four owned paths are part of this evidence. Main owns runner/proposer/preload/CLI integration, legacy receipt handling, image rebuilding, keyless Docker rehearsal, and the repository feedback record.

Integration example (validate the wrapper before copying it): require exactly `records` and `dropped_count`, an array of at most 32 records, and a nonnegative safe-integer drop count. Call `validateGatewayFailure` on every record before retaining any of them. The validator throws only `GATEWAY_FAILURE_INVALID`; it does not sanitize by copying unknown fields. Missing `failure_diagnostics` is a historical receipt, not an empty observed diagnostic set. Current records always include nullable `provider_error_type` and `provider_error_code`.
