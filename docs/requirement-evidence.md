# Requirement Evidence

## CI process mock repair (2026-09-10)

Change: `chg-ci-process-mock-20260910`. CI run `34426075224` reported repeated
`process.nextTick is not a function` worker IPC exceptions while transport tests
replaced the entire global process object with an environment-only object.
The test helper now delegates Node APIs and unrelated runtime environment reads
to the real process while observing credential reads. A regression schedules
`nextTick` and `setImmediate` under that mock and verifies IPC method preservation.

Focused fork-pool proof: 250 tests passed. Full `pnpm run check`: 778 tests passed,
seven opt-in skips; typecheck/build, capsules, policy and both offline scorecards
passed. Production code, schemas, paid evidence and budget ledgers are unchanged.
Feedback: `.dal/store/fb-ci-process-mock-20260910.json`.

## Anthropic baseline passed with updated key (2026-09-10)

Change: `chg-dal-anthropic-baseline-success-20260910`.
Status: completed. The single approved full Sonnet 5 Off attempt passed all three
independent refund-workflow goals. It completed six gateway responses, seven tool
calls and the task in 18251 ms, with captured usage of 84253 input and 781 output
tokens. There were zero gateway failures or rejections in this attempt.

Manifest `4896c330b7d22065b508d9879505d83107159ad8219dae753b3697dd6f981a05`
verified before operation-time approval. Run
`run-e2e-2a85a605607b5120d1f2a5f8234a7b6d1831ad254263a25e` and execution receipt
`rcp-task-001-refund-1eac5500` retain the exact source/image, task, candidate and
grader evidence. Summary: `.dal/check/e2e-summary-anthropic-updated-key-01.json`.

This attempt reserved 2243576 microUSD; cumulative Anthropic reservations are
3350024, leaving 1649976 of the original five USD allocation. Reservations are
not measured provider charges or account credits. All prior failed-attempt and
diagnostic reservations remain charged; no refund or reset occurred.

Both providers now have one passing baseline task, under their recorded runtime
configurations. This is not a paired candidate comparison, adaptation gain, or
general reliability claim. No additional run, OpenAI call, proposal generation,
or candidate activation occurred. Owned containers and networks are cleaned up.

Result: `.dal/check/paid-anthropic-updated-key-20260910-result.json`.
Feedback: `.dal/store/fb-dal-anthropic-baseline-success-20260910.json`.

## Updated Anthropic key access check (2026-09-09)

Change: `chg-dal-anthropic-key-access-20260909`.
Status: completed — one approved minimal direct request returned HTTP 200 and
the expected `OK` answer on `claude-sonnet-5` with thinking disabled.
Usage was 15 input tokens, four output tokens, and zero cache read/write tokens.
The call used no DSH, DAL gateway, tools or workspace data and did not rerun the
full benchmark. Its successful result after the user changed the key strongly
supports the prior credential/access diagnosis, without certifying the complete
workflow payload or assigning a cause to every historical failure.

The existing campaign ledger reserved 44072 microUSD before credential access.
Anthropic cumulative reservations are 1106448 microUSD; remaining allocation is
3893552. These are not measured provider charges or account balances. No original
reservation or failure evidence was reset, and no second diagnostic or other
provider call followed.

Result: `.dal/check/anthropic-updated-key-check.result.json`.
Validated feedback: `.dal/store/fb-dal-anthropic-key-access-20260909.json`.
Any full-workflow retry still requires its own exact approval.

## Minimal Anthropic diagnostic (2026-09-09)

Change: `chg-dal-anthropic-minimal-diagnostic-20260909`.
Status: diagnostic completed; provider access remains unresolved.

The user accepted one minimal tool-free diagnostic. Its exact short-lived
data-transfer approval validated before the existing campaign ledger reserved
44072 microUSD and before credential access. The request went directly to the
Messages endpoint, with Sonnet 5, explicit disabled thinking, a static response
probe and a 16-token output limit. It used neither DSH/pi-ai nor the DAL gateway,
tools or workspace data.

The provider returned HTTP 400 `invalid_request_error`. A fixed local classifier
of the bounded error message reported `credential_or_authentication_restriction`;
raw provider text was not retained. Local checks reported a regular Anthropic
API-key format, not OAuth, and no inherited environment override of `.env`.
No key values were displayed. This demonstrates rejection independently of the
DSH/pi-ai and DAL gateway/tool layers and points to key/account-use restrictions;
it does not prove which restriction or exclude coexisting full-payload defects.

The earlier wrong reasoning capability override and coarse error masking were
DAL issues, not evidence that DSH cannot use Anthropic. The remaining step is
checking the key's funded organization/workspace and model/client restrictions,
not another blind full benchmark or a speculative DSH patch.

Result and analysis remain private under `.dal/check/anthropic-minimal-diagnostic.*`.
Anthropic cumulative reservations are 1062376 microUSD, with 3937624 remaining;
these are allocations rather than measured charges or account credits. Exactly
one diagnostic request occurred and no subsequent provider call or activation.
Feedback: `.dal/store/fb-dal-anthropic-minimal-diagnostic-20260909.json`.

## Approved Anthropic Off attempt (2026-09-09)

Change: `chg-dal-paid-anthropic-off-20260910`.
Status: blocked — the single approved explicit-Off attempt received upstream
HTTP 400 `invalid_request_error`, without a specific provider code, response
body or task result. Exact manifest and short-lived approval verified before
execution. The gateway admitted the required disabled-thinking body, so explicit
Off is not sufficient to resolve the provider rejection; the exact cause remains
unclassified. No further retry or proposal call occurred and OpenAI was untouched.

The attempt reserved 339600 microUSD. Anthropic campaign reservations now total
1018304, leaving 3981696 of the original five USD allocation. These are not actual
provider charges or an account balance. Reservations were retained, not refunded.
Owned containers and networks are cleaned up. No model-quality score is assigned.

Result: `.dal/check/paid-anthropic-off-20260910-result.json`.
Feedback: `.dal/store/fb-dal-paid-anthropic-off-20260910.json` (blocked).
Further work should isolate a minimal provider/account diagnostic and preserve
a privacy-safe reason classification rather than repeat the full workflow blindly.

## Explicit Anthropic Off (2026-09-09)

Change: `chg-dal-anthropic-off-20260910`.
Status: completed locally; no paid retry performed.

The Anthropic DSH profile now selects `reasoning: off` and preserves the native
Sonnet reasoning capability instead of setting `reasoningEfforts: false`.
The gateway requires exactly `thinking: {type: "disabled"}` before reservation;
omission, adaptive/manual thinking, extra fields and signed-thinking replay remain
denied. Direct and metered Anthropic proposals send the explicit disable as well.
New direct Anthropic envelopes use v3; frozen v1/v2 schemas remain unchanged and
OpenAI/DeepSeek request-byte regression checks pass.

Focused verification: 422 tests passed across transport, proposal, metered handoff,
gateway and runner suites. Full `pnpm run check`: all 43 test files pass, 777 tests
pass, seven opt-in tests skip; typecheck/build, capsules, policy and both offline
scorecards pass. Review reports no findings. Source pins are synchronized to
capsule version 1.7.5 without extending freshness bounds or changing other pins.

Actual keyless DSH rehearsal completed two Anthropic requests under a gateway
that now rejects missing or non-disabled thinking. It performed `get_order` then
`DONE`, with zero owned resources remaining. The no-op refund oracle intentionally
failed; this verifies wire mode and protocol, not real provider capability.
Image: `sha256:e42107c7e86349a199f29a987988d39795454955d8ab2410a6eb042b41042f1a`.
Summary: `.dal/check/rehearsal-runs/anthropic-off-20260910/summaries/e2e-summary-off-wire-01.json`.

A fresh, unapproved Anthropic retry manifest is prepared under the original
campaign cap and ledger:
`.dal/check/paid-adaptive-20260908-anthropic-off.manifest.json`, digest
`90aeeba2383f63d77aaaf29da7789771fa5f513df24b0d438d63769dc8c20238`.
The historical HTTP 400 cause remains unproven; explicit Off fixes the confirmed
mode defect, not a retrospectively invented cause. Old paid records and
reservations are untouched. No provider calls, keys read, activation, commit or
push occurred. Feedback: `.dal/store/fb-dal-anthropic-off-20260910.json`.

## Approved repaired baseline retries (2026-09-09)

Change: `chg-dal-paid-retry-20260909`.
Status: OpenAI baseline passed; Anthropic remains execution-blocked. Exactly one
approved retry per provider ran, using the repaired manifests and the original
campaign caps. No source changes, extra model requests, proposal generation or
activation followed these two attempts.

OpenAI `gpt-5.6-terra` completed five gateway requests, six tool calls and all
three independent refund-workflow goals in 16345 ms. Captured usage is 36845 input
and 207 output tokens. Execution receipt `rcp-task-001-refund-77b5af0f` binds the
approved manifest, model, image, state/effects and passing grader verdict. Summary:
`.dal/check/e2e-summary-openai-repair-01.json`. This is one successful baseline
task, not evidence of adaptation gain or general reliability.

Anthropic `claude-sonnet-5` failed its first admitted request. New diagnostics
record upstream HTTP 400 and `invalid_request_error`, with no specific provider
error code. No assistant usage or task score is available. The precise cause
within this broad error class remains unknown; it is not scored as model inability.

OpenAI reserved 2355010 microUSD for this retry, reaching 2786492 cumulatively.
Anthropic reserved 339352, reaching 678704 cumulatively. Campaign reservations
total 3465196 microUSD, not measured provider spending. Remaining allocations
are 3213508 and 4321296 microUSD respectively. No reservation was refunded.
All owned containers and networks are cleaned up.

Safe results: `.dal/check/paid-adaptive-20260908-retry-result.json`.
Feedback: `.dal/store/fb-dal-paid-retry-20260909.json` (blocked until a valid
Anthropic baseline exists). Prior failures and evidence remain unchanged.

## Live gateway repair (2026-09-08)

Change: `chg-dal-live-gateway-repair-20260908`.
Status: completed offline and keyless-runtime verified; no paid retry performed.

Native offline reconstruction from saved OpenAI evidence produced a 40211-byte
second request containing empty-visible encrypted reasoning, a complete tool call
and inline output. It failed the input guard; removing the reasoning item admitted
the reconstructed request. The historical exact wire body was not saved, so this
is native reconstruction proof rather than a historical packet capture. Serialized
size and function-call status were not the reproduced rejection mechanism.

The image-bound caller projection now explicitly disables wire reasoning, removes
only empty-visible reasoning history and optional paired function item IDs, and
preserves visible messages, arguments, outputs and call linkage. The gateway still
rejects opaque/reference-only reasoning. Nonempty visible reasoning fails closed.
Both native keyless DSH rehearsals pass after the repair, including an OpenAI
reasoning-plus-tool fixture that reproduces the missing coverage. This remains
protocol proof with an intentionally failed business oracle, not provider quality.

Gateway diagnostics persist a bounded closed vocabulary of failure stage/guard,
observed HTTP status and allowlisted provider identifiers, without raw bodies,
messages, ciphertext, keys or stacks. The runner validates and retains these
records. Missing launcher credentials are checked after exact approval but before
claiming the attempt. The original Anthropic failure remains unknown; tests of
401/400/429 and other diagnostic paths do not retroactively establish its cause.

Final verification: `pnpm run check` passes all 43 test files, 743 tests with seven
opt-in skips, typecheck/build, all capsules, policy and both offline scorecards.
Focused repair proof passed 140 tests with one optional topology skip. Code review
reports no remaining actionable findings in the repair. Capsule source pins are
reconciled to 1.7.4 without extending freshness bounds or altering unrelated pins.

Verified repaired image:
`sha256:3dd84e86a6e82258b5c4ab84460fb47f16c02133d00ea5b4a814b2ecd032bdde`.
Rehearsal summaries:
`.dal/check/rehearsal-runs/repair-20260908/summaries/e2e-summary-openai-replay-01.json`
and `e2e-summary-anthropic-diagnostics-01.json`. Both protocols completed with zero
gateway rejections. Owned containers/networks are cleaned up.

Fresh, unapproved retry manifests use the original campaign and six/five USD
caps, preserving the original failed attempts' reservations:
- OpenAI: `5e0c16309d7586c2ef06a1ef44fafeb6c6ff7a18fa5d828102e52e3e80f6eba6`.
- Anthropic: `e5eb669b6e56cb6e15bed5a5591436c3a17f70c3603c3a3559baeef896a84e12`.

These code/image changes invalidate earlier paid approvals. Original receipts,
claims and reservations are not reset or rewritten. No new provider request,
actual credential inspection, candidate activation, commit or push occurred.
Completion feedback: `.dal/store/fb-dal-live-gateway-repair-20260908.json`.

## First approved paid baseline (2026-09-08)

Change: `chg-dal-paid-baseline-20260908`.
Status: blocked — both live executions stopped before a completed task; no valid
baseline or adaptation-benefit result is available.

The user approved the exact prepared OpenAI/Anthropic manifests and six/five USD
campaign caps. Both short-lived decisions validated at the CLI and again at the
execution boundary. Image/source manifests reverified unchanged before launch.

| Provider | Direct observation | Reserved allocation |
| --- | --- | ---: |
| OpenAI `gpt-5.6-terra` | One upstream response completed; 6541 input and 56 output tokens captured; one successful `skill` call; next request rejected before forwarding | 431482 microUSD |
| Anthropic `claude-sonnet-5` | One reservation, one failed gateway operation, zero response bytes; no assistant reply/tool execution | 339352 microUSD |

Total reserved allocation is 770834 microUSD, not actual billing. No refund or
paid retry was performed. Both service journals contain only their seed and zero
business effects. Offline inspection confirms unfinished goals, not model
inability. No branch score or improvement claim is published from these failures.

OpenAI initially stopped before gateway creation because the launcher omitted
explicit `.env` loading. After confirming no OpenAI ledger reservation or owned
resources existed, the untouched prelaunch policy was archived with a recovery
record and the identical approved scope resumed with explicit launcher loading.
This recovery did not repeat an upstream request or change source/manifest bytes.

OpenAI's rejected follow-up may involve reasoning replay, another unsupported
SDK field, or another pre-reservation check; the exact rejected request and
failing guard are unavailable. Anthropic's upstream status/error stage was not
persisted, so the precise cause is unknown. Add safe status/guard diagnostics and
reproduce the replay path offline before preparing any new paid approval.

Safe result: `.dal/check/paid-adaptive-20260908-result.json`.
Gateway receipts are under `.dal/check/e2e-gateways/` for the approved run IDs.
Raw session data stays local. All owned containers and networks are cleaned up;
the ledger and original failure evidence are retained.
Feedback: `.dal/store/fb-dal-paid-baseline-20260908.json` (blocked).

## Paid e2e preflight complete (2026-09-08)

Change: `chg-dal-paid-e2e-preflight-20260907`.
Status: completed for the first paid baseline batch; actual paid authorization
and execution are not part of this receipt.

| Requirement | Observed proof |
| --- | --- |
| Fixed-route, credential-isolated broker with durable cost admission | Gateway/ledger tests cover no upstream before reservation, concurrency, duplicate/retry refusal, partial outcomes, forbidden remote/media/built-in-tool inputs, response bounds and numeric JSON expansion |
| Real DSH through both native provider protocols | Final image rehearsals for exact Terra and Sonnet each observed successful `get_order` then `DONE`; protocol passed while the intentionally no-op refund oracle failed |
| Candidate isolation and cleanup | Before/after daemon inspections match: internal candidate network only, no provider keys/ledger/socket mounts, read-only container roots, no rehearsal egress; no owned containers/networks remain |
| Rollout and automatic proposal share the cap | Same-campaign local HTTP proposal rehearsals increased ledger totals from 865974 to 945746 microUSD for OpenAI and 681384 to 740088 for Anthropic; these are synthetic reservations, not charges |
| No rehearsal contamination | New rehearsal records are stored outside `.dal/runs`; selected mode-tagged and recognizable historical rehearsal evidence is denied by proposal preparation |
| Reviewed source actually matches the image | Builder compiles before staging, compares source maps, excludes repository/credential context, and rehashes in-image compiled artifacts and schemas; stale or malformed provenance fails preflight |
| Finite exact manifests without invented approvals | Campaign preparation and regeneration verification pass; one task/attempt per provider, exact models, shared ledger and explicit 6000000/5000000 microUSD caps; requests remain pending and unauthorized |

Final derived image:
`sha256:1897ee195e20401dac7571d031fc5160ebca43802f425cb7fb7801a6e82f6945`.
Source map digest: `bb95a86c97b7ecdde44fd41e09b907e4bc97b182b7401db3730cc7860a7ba5d4`.
Compiled artifact digest: `eaa7c3f19fc98669e7cd1414a1c0bef8e003a3c7133681564abe36d96fbfe9a3`.

Final rehearsal summaries are under
`.dal/check/rehearsal-runs/readiness-20260908/summaries/` for `openai-final`
and `anthropic-final`. Each final protocol observation reports one successful
tool call and a finish. Business failure is an intentional negative control,
not a claim about either real provider's capability. Raw private artifacts are
not committed. Earlier experiments are retained, not reset into fresh budgets.

Prepared live campaign: `.dal/check/paid-adaptive-20260908-ready/`.
OpenAI transmission digest:
`f95ad01fd29209b4d9bc8edc8e3a7411aed2b59f7e714991718d1a24244cd298`.
Anthropic transmission digest:
`af55a7b73fc46346f0d20891c5cda313a23e5e01160e02a6619133410a6dc80c`.
Verification regenerated these manifests after the final source/image build.
Phase two prepares a new exact metered-proposal manifest only after baseline
evidence exists; it does not pre-approve an unknown candidate or payload.

Final `pnpm run check`: all 42 files pass, 709 tests pass and seven opt-in tests
skip; typecheck/build, all three capsules, allowed-read policy and both offline
scorecards pass. Final security review reports no remaining high/medium blocker
for the first paid baseline. Spec/architecture/roadmap capsule pins are reviewed
and refreshed to 1.7.3, without extending freshness bounds or changing unrelated
pins. No separate intermediate capsule gate remains.

The cost ceiling is conditional on the manifest's conservative pricing and
text-token bound; it is not provider invoice measurement, taxes, unrelated
account spending, or immunity to a malicious ledger owner. No paid model call,
real credential inspection, activation, commit or push was performed.
Completion feedback: `.dal/store/fb-dal-paid-e2e-preflight-20260908.json`.

## Automatic multi-provider proposals (2026-09-07)

Change: `chg-dal-multiprovider-proposals-20260907`.
Status: completed locally after human-approved spec/roadmap capsule refresh.
Both affected capsules are version 1.7.2; other source pins, claims and freshness
bounds are preserved.

| Requirement | Implementation | Observed evidence |
| --- | --- | --- |
| Exact OpenAI Terra and Anthropic Sonnet proposal routes without fallbacks | Native Responses/Messages adapters and strict v2 envelope; legacy explicit DeepSeek retained | 222 transport/schema tests pass, including reasoning-plus-answer output, tools/refusals/truncation, headers, credential selection and request tampering |
| Automatic proposal generation from recorded failures | Ingestion, clustering, prepare, exact approval, real proposer orchestration with mocked native responses, persisted draft | 24 automatic tests pass for both exact models without runnerOverride |
| Reserve before credential access/send and never refund unknown results | Per-budget/provider locked, fsynced, chained reservation ledger | 44 ledger tests pass, plus orchestration tests for exhaustion, duplicate sends, conflicts and failures |
| CLI and workbench carry the same budget-bound request | Required budget file, explicit provider/model options and reservation allocation output | 20 proposer and 21 plugin-mode tests pass after rebuilding the CLI used by plugin subprocess tests |
| Preserve historical machine contracts | V1 request schema remains unchanged; new sends use v2; draft provider provenance extended | Old schema retained; new complete request digest needs fresh approval |

After approved refresh, full `pnpm run check` passes typecheck/build, all 37 test
files (578 passed tests, seven opt-in skips), all capsules, the allowed-read
policy and both offline scorecards without hard stops. Final review reports no
code findings; diff whitespace checks pass. The earlier source-pin failure is
preserved in the blocked receipt rather than rewritten. Earlier verification
caught a stale built CLI and strict OpenAI single-item parser; rebuild and
reasoning-envelope tests resolve those issues.

This proves the complete automatic **proposal stage** locally with mocked
providers, not live model execution or generated executable patches. Budget
reservations are approved allocations, not invoice measurements or a hard
account-dollar ceiling. The separate DSH rollout runner still requires its own
credential-isolated budget enforcement and price bounds before paid e2e claims.

Completion feedback: `.dal/store/fb-dal-multiprovider-proposals-complete-20260907.json`.
It supersedes `.dal/store/fb-dal-multiprovider-proposals-20260907.json` without
modifying that prior blocked receipt.
No actual API key values were read, no model requests were sent, no candidate
was installed/activated, and no commit/push was performed. The pre-existing
`HANDOFF.md` deletion remains untouched.

## Proposer request and branch receipt boundary (2026-09-06)

Change: `chg-dal-proposer-receipt-boundary-20260906`.
Status: completed locally after the human-approved contract/capsule refresh.
Capsules `dal-v0-contract` and `dsh-adapter-boundary` version 1.7.1 bind the
reviewed source bytes; unaffected source pins and freshness bounds are preserved.

| Requirement | Owner / implementation | Observed verification |
| --- | --- | --- |
| Bind full outbound request before credential access and send | `docs/proposer-request.md`, strict `proposer-request.v1` schema, `src/propose.ts`, `src/propose-transport.ts` | Fixed route/model/body/version and approval drift tests pass; old payload approvals rejected |
| No DSH workspace/profile/tool/subprocess authority | Fixed text-only HTTPS transport; Docker rejected; no `.env` loading | Mocked transport, no-credential-before-approval, bounded timeout/body, redirect/tool-call and sensitive-output tests pass |
| Bind the actual branch artifact and full task revision | `docs/branch-evidence.md`, branch/receipt schemas and `src/branch.ts` | Wrong candidate, null verdict, missing task/base binding and same-ID task drift controls pass |
| Revalidate evidence before counting, with no repeated execution credit | Versioned proof replay and stable session/task identity | Artifact/state/receipt/score drift, concurrent retry, conflicting reuse and legacy exclusion controls pass |
| Preserve workbench preparation without a model call | CLI and `dal_proposal_prepare` require an explicit model and report request digest/path | Plugin integration and missing-model control pass |

`pnpm exec vitest run tests/propose.test.ts tests/propose-transport.test.ts tests/branch.test.ts tests/execution-receipt.test.ts tests/cli.test.ts tests/plugin-modes.test.ts`:
131 passed in the focused implementation run. After approved capsule refresh,
full `pnpm run check` passes typecheck/build, 327 tests (seven opt-in skips),
all three capsules, allowed-read policy, and both offline scorecards without
hard stops. The earlier source-pin failure remains recorded in the blocked
receipt below rather than being rewritten. Diff whitespace checks passed.

New request/draft/receipt fields are additive where historical records exist;
legacy records remain readable but incomplete branch proofs cannot earn visits.
Old proposer approval digests require new preparation and approval. The new
transport has no live-provider proof, and local receipt integrity is not
independent runtime attestation or a completed cross-repository benchmark.

Completion feedback: `.dal/store/fb-dal-proposer-receipt-boundary-complete-20260906.json`.
It supersedes `.dal/store/fb-dal-proposer-receipt-boundary-20260906.json` without
modifying the prior immutable record.
No model call, profile mutation, plugin installation, activation, commit or push
is part of this increment.

## Integrated Recorder and Staging Gate (2026-09-06)

Change: `chg-dal-recorder-staging-integration-20260906`.
Acceptance: preserve the approved recorder/controller and staging increments together with main's runtime attestation and HMR quarantine; synchronize reviewed source pins; pass focused regressions and the full repository gate; exclude raw transcripts, generated artifacts, and unrelated evaluator feedback from publication.

The normal merge integrates main through `b0e664a` without weakening controller qualification. The direct bridge test now supplies synthetic launcher-owned, session-bound evidence and a 1.1.0 policy. Missing evidence fails estimation; conflicting or transition-spanning bindings remain unbatched, with launcher pins preserved. Production recording still cannot trust the quarantined in-process HMR candidate state.

- Focused gate: 7 files passed, 79 tests passed, 1 opt-in test skipped.
- Full `pnpm run check`: typecheck and build passed; 34 files passed, 240 tests passed, 7 opt-in tests skipped; all 3 capsules validated; allowed-read policy passed; core and workflow benchmark scorecards passed without hard stops.
- Merge verification caught the legacy bridge fixture and the capsule test's pre-refresh fixed clock. The fixture now exercises attestation instead of bypassing it, and the fixed clock matches the reviewed refresh date; drift and expiry rejection remain tested.
- Capsules `dal-v0-contract` and `dsh-adapter-boundary` version 1.7.0 retain all merged semantic claims, update the reviewed spec/architecture/roadmap digests, and retain existing freshness deadlines and unaffected source identities.
- No model request, host profile change, installation, live HMR probe, image rebuild, or candidate activation was performed. The private evaluator repository was not changed.

Integration feedback: `.dal/store/fb-dal-recorder-staging-integration-reviewed-20260906.json`. It supersedes the preliminary integration receipt to correct a local-clock-to-UTC transcription; verification results are unchanged. Earlier receipts below remain immutable historical evidence, not proof for this merged tree.

## DAL-021 staging integrity increment (2026-09-05)

### Closure after approved capsule refresh

The maintainer approved the roadmap delta and its source-pin refresh on
2026-09-05. Capsule `capsule-dsh-adapter-boundary` version `1.4.1` binds the
reviewed roadmap bytes; other source pins and freshness bounds are preserved.
The bounded staging increment is complete locally: `pnpm run check` passes
typecheck, build, 216 tests (six opt-in skips), all capsule checks, the policy
fixture, and both offline scorecards. This does not prove model execution or
activation and does not complete the broader evolution roadmap.

Completed feedback: `.dal/store/fb-dal-evolution-staging-integrity-complete-20260905.json`.
It supersedes the review receipt below without changing prior immutable records.

### Historical Review Fix: Verdict Output Conflict

Final state for `chg-dal-evolution-staging-integrity-20260905`: the adapter checks exclusive verdict publication before any candidate staging. The CLI delegates publication to that boundary. An existing verdict fails with `OPTIMIZE_OUTPUT_CONFLICT`, keeps its bytes unchanged, emits no successful evaluation output, and creates no candidate or staging directory. The regression covers both valid and rejected candidates. Subsequent staging errors may leave the newly published verdict; the focused contract documents this ordering.

- `pnpm exec vitest run tests/optimizer-adapter.test.ts tests/workflow.test.ts`: 33 tests passed (24 optimizer, 9 workflow).
- `pnpm run check`: typecheck and build passed; 215 tests passed, 6 opt-in skips, and the expected single capsule-integrity failure. Later chained verification stages did not run.
- `pnpm dal capsule check capsules/dsh-adapter-boundary.json`: the existing `/sources/2` roadmap digest mismatch remains; the dirty capsule was not changed.
- `git diff --check`: passed.

Superseding blocked feedback: `.dal/store/fb-dal-evolution-staging-integrity-review-20260905.json`, sourced from the matching `.dal/outbox/` file. It supersedes `fb-dal-evolution-staging-integrity-20260905`; the old outbox and immutable stored receipt remain unchanged. This follow-up changes only the CLI/adapter publication ordering, optimizer regression tests, focused contract/evidence, and its new feedback pair. No activation, external transfer, model call, commit, or unrelated implementation change was performed.

### Historical Initial Increment Evidence

Change: `chg-dal-evolution-staging-integrity-20260905`. At this stage, bounded implementation and focused tests passed; full closure was blocked on human-reviewed roadmap capsule refresh. These historical results are preserved; the closure above resolves that blocker.

| Requirement | Implementation / contract | Observed evidence |
| --- | --- | --- |
| Record the accepted full direction before code; distinguish future priorities | `ROADMAP.md`, `docs/optimizer-staging.md` | Roadmap updated before implementation; independent evaluator and complex controllers remain future scope |
| Bind candidate to exchange target/base and verify actual base bytes before reconstruction | `src/optimizer-adapter.ts` | Target/base/exchange mismatch, on-disk drift with surviving anchors, and lossy UTF-8 byte-drift regressions pass |
| Never return or stage rejected candidate text | Adapter gate and CLI delegation | Invalid surface, target, exchange, digest, no-change, and missing-anchor regressions pass |
| Confine exclusive raw-Markdown publication to direct `.dal/candidates/*.md` paths | `docs/optimizer-staging.md`, adapter staging block | Raw byte/digest roundtrip, file mode, existing-file preservation, live/outside/nested path denial, symlinked roots and existing/dangling symlink tests pass |
| Remove the overwrite-capable general writer | `src/json.ts`, CLI preparation, unique exchange path, workflow fixture callers | Prepare/evaluate CLI and workflow regressions pass; no optimizer schema fields changed |
| Run focused tests then the full gate | Local commands below | Focused pass; full gate blocked by the roadmap source digest in `capsules/dsh-adapter-boundary.json` |

Commands observed for this increment only:

- `pnpm exec vitest run tests/optimizer-adapter.test.ts`: final focused run passed 22 tests; the first run exposed four test-fixture path/base failures, corrected before the passing run.
- `pnpm exec vitest run tests/optimizer-adapter.test.ts tests/workflow.test.ts`: 31 tests passed after removal of the general writer.
- `pnpm run check`: typecheck and build passed; test phase had 213 passed, 6 opt-in skipped, and 1 failed capsule-integrity test. Later capsule/policy/scorecard commands in the chain did not run.
- `pnpm dal capsule check capsules/dsh-adapter-boundary.json`: failed closed on `/sources/2`, the changed `ROADMAP.md` digest. The existing dirty capsule was not refreshed or overwritten; a maintainer must review the accepted roadmap delta, refresh the pin, and rerun the full gate.
- `git diff --check`: passed.

Required blocked feedback: `.dal/outbox/fb-dal-evolution-staging-integrity-20260905.json`, ingested as `.dal/store/fb-dal-evolution-staging-integrity-20260905.json`. No model request, external transfer, installation, activation, commit, or push was performed. Recorder/controller changes and evaluator ownership remain untouched. This is local staging evidence, not protection from concurrent same-user directory replacement or a real cross-repository evaluation/deployment slice.

## Prior Increment Evidence

Status: Run-mode controller observation path, complete repository gate, and task feedback passed
Changes: `chg-control-supervisor-foundation-20260902`, `chg-run-controller-observation-path-20260902`
Evidence date: 2026-09-02

## Attestation and HMR Evidence

Status: HMR admission claim corrected and candidate application quarantined
Changes: `chg-control-supervisor-foundation-20260902`, `chg-runtime-generation-attestation-20260902`, `chg-hmr-adaptive-plugin-loop-20260904`, `chg-hmr-runtime-generation-stack-20260904`, `chg-hmr-readiness-admission-20260905`
Evidence date: 2026-09-05

This matrix maps canonical requirements to executable or inspectable evidence. “Pass” means the named evidence was observed in the current workspace; it does not imply model-backed benchmark quality or candidate promotion.

## Requirements

| Requirement | Implementation owner | Evidence | Current result |
| --- | --- | --- | --- |
| DAL-001 structured feedback | `schemas/feedback-log.v1.schema.json`, `src/feedback.ts` | `tests/feedback.test.ts` | Pass |
| DAL-002 required task workflow | `AGENTS.md`, `.agents/skills/end-task-feedback/SKILL.md` | Feedback validation/ingestion workflow | Pass |
| DAL-003 immutable local aggregation | `schemas/stored-feedback-record.v1.schema.json`, `src/store.ts` | `tests/store.test.ts` | Pass |
| DAL-004 staged human lifecycle | `schemas/improvement-proposal.v1.schema.json`, `src/improvement.ts` | `tests/workflow.test.ts` | Pass |
| DAL-005 disabled optimizer boundary | `schemas/optimizer-exchange.v1.schema.json`, `src/optimizer.ts` | `tests/workflow.test.ts` | Pass |
| DAL-006 source-bound capsules | `schemas/knowledge-capsule.v1.schema.json`, `src/capsule.ts`, `capsules/` | `tests/capsule.test.ts`, `dal capsule check capsules` | Pass |
| DAL-007 developer commands | `src/cli.ts`, `README.md`, `docs/operator-guide.md` | `tests/cli.test.ts` | Pass |
| DAL-008 exact human approval | `schemas/approval-decision.v1.schema.json`, `src/approval.ts` | `tests/workflow.test.ts` | Pass |
| DAL-009 guardrails and evaluation | Guardrail/evaluation schemas, `src/guardrail.ts`, `src/evaluation.ts` | `tests/guardrail.test.ts`, `tests/evaluation.test.ts`, `v0-suite.json` | Pass |
| DAL-010 self-improvement loop core | Run/cluster schemas, `src/runs.ts`, `src/clustering.ts`, proposal rules | Clustering, workflow, and run fixtures | Pass |
| DAL-018 evidence reset and rebaseline | Reset schema, `src/reset.ts`, `.dal/resets/` receipts | `tests/reset.test.ts` | Pass |
| DAL-019 run and improvement plugin modes | `plugins/dal-modes/`, `plugins/dal-run-record/`, `plugins/dal-improve-tools/`, `plugins/dal-hmr-candidate/` | Plugin-mode and HMR-candidate tests, including terminal enrollment and privacy assertions | Pass |
| DAL-020 container-hosted harness execution | `src/docker.ts`, `deploy/docker/`, Docker policy seams | `tests/docker.test.ts`; historical approved image build and live probes | Static pass; current image not refreshed |
| DAL-021 SkillOpt-shaped optimizer adapter | `src/optimizer-adapter.ts`, optimizer schemas | `tests/optimizer-adapter.test.ts` | Pass |
| DAL-022 benchmark measurement integrity | Workflow task/receipt/run schemas; grader/service/e2e driver; disabled G2 source | Grader, service, topology, receipt, summary, branch, clustering, and G2 tests | Pass |
| DAL-023 run-to-run controller observation | Controller policy/state schemas; `src/control/`; run-mode terminal bridge; CLI and evidence-store integration | `tests/controller.test.ts`, `tests/plugin-modes.test.ts`, init/reset/CLI tests | Pass |
| DAL-024 runtime generation attestation | Runtime manifest/evidence schemas; `src/runtime-generation.ts`; recorder binding; controller evidence gate | `tests/runtime-generation.test.ts`, controller/plugin/provenance tests | Pass; combined full gate passed 219 tests with 7 opt-in skips |
| DAL-025 quarantined HMR candidate staging | `plugins/dal-hmr-candidate/`, generation-aware `dal-run-record`, run-record schema/semantics | `tests/hmr-candidate.test.ts`, opt-in DSH readiness probe, `tests/plugin-modes.test.ts` | Pass; application/live publication removed, generation state runtime-private and always non-admitted, drift-safe rejection covered |

## DAL-022 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Harness completion remains separate from the deterministic business verdict | Run schema/semantics, fixtures, clustering and optimizer tests | Pass |
| Failed business outcomes name a failed deterministic check | Run schema condition and semantic validation | Pass |
| Refusal success requires evaluator-owned effect evidence | `workflow-task.v1`, grader `2.0.0`, refusal fixtures/tests | Pass |
| Journal replay is checksummed, serialized, crash-safe, and fail-closed | Workflow service source and HTTP/tool tests | Pass |
| Candidate, service, and grader use distinct mounts and networks | `e2e-topology.ts`; static and live topology tests | Pass |
| Approval manifest binds full evaluator inputs, rendered patch, driver source, rollout count, and image | `run-e2e.ts`; topology/manifest tests | Pass |
| Every attempt revalidates staged inputs before the model boundary | Manifest-drift and staged-input checks | Pass |
| Receipts bind task, run, candidate, model, generation, image, manifest, state, journal, verdict, and isolation | Receipt schema plus e2e summary regression tests | Pass |
| Summaries bind persisted run records, reject reused evidence, and recompute metrics | `e2e-summary.ts`, 13 focused summary tests | Pass |
| Frozen-context comparison rejects benchmark drift and model/candidate confounding | Summary comparison tests | Pass |
| Arbitrary or G2 execution labels cannot claim an ordinary run | Driver and summary validation tests | Pass |
| G2 unknown-effect guard remains source-only and retains same-key locks until terminal evidence | Disabled bundle row and G2 unit tests | Pass |
| The 2026-09-01 source baseline was rebuilt into the benchmark image and re-probed | Historical image identity plus live topology/Landlock/denial probes | Historical pass |

## DAL-023 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Controller state is separate from candidate proposal lifecycle | ADR 0004, focused contract, distinct schemas/store | Pass |
| One estimate uses an exact task set, batch, context, and pinned generation | `src/control/estimator.ts`, mixed-context/generation tests | Pass |
| Harness, business, and deterministic-check metrics have explicit denominators and exclusions | Controller policy/state schemas and fixture assertions | Pass |
| Estimates include versioned two-sided 95% Wilson intervals | `dal-wilson-score-v1`, estimator and tamper tests | Pass |
| Inadequate samples produce non-authorizing `insufficient_evidence` | Minimum-sample test | Pass |
| Complete snapshot identity and estimate time are deterministic; identical publication is idempotent | State tamper and retry tests | Pass |
| Existing persisted policy snapshots remain valid | Controller defaults stay outside `policy.v1`; guardrail CLI regression test | Pass |
| Command performs no proposer, model, network, sandbox, budget, transition, application, promotion, or rollback action | Static boundary review and command implementation | Pass |
| Explicit run-mode pins produce schema-valid terminal records consumable without fixture rewriting | Recorder-to-controller integration test and controller state assertions | Pass |
| Checkpoints, incomplete sessions, unsupported terminal reasons, non-canonical tools, and observed-context contradictions stay outside the configured batch | Recorder eligibility regression tests | Pass |
| Default recording stays unbatched and excludes raw prompt, message, argument, and result content | Existing recorder privacy test plus explicit null batch assertion | Pass |
| Summed token usage is represented by the run-record schema and persisted by the recorder | Run schema and recorder projection assertion | Pass |
| Controller-state evidence remains VCS-visible in initialized and repository workspaces | Init scaffold test and repository `.gitignore` consistency test | Pass |

## DAL-024 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Closed runtime manifest has deterministic RFC 8785 JCS identity and complete artifact references | Manifest schema/validator, digest fixture, malformed-I-JSON and closure tests | Pass |
| Appraisal is separate and distinguishes declared, observed, and verified assurance | Evidence schema/validator and required-claim tests | Pass |
| Session binding occurs only at creation and transition attempts remain visible after rollback | Recorder source contract, explicit checkpoint stage, monotonic sequence check, checkpoint/transition tests | Pass (synthetic service); production final-write availability is not proved because DSH disposal is not awaited |
| Existing harness identity remains independent | Run schema/type and recorder/controller assertions | Pass |
| Existing controller 1.0 policy/state snapshots remain valid without implicit attestation | Version-conditional schemas and legacy migration tests | Pass |
| Controller loads evidence and manifest through checked descriptors and fails closed on missing, unstable, downgraded, mixed, duplicate-session, unavailable, replayed, symlink-traversing, or forged identity | Controller estimator/store and focused negative tests | Pass |
| DSH emits authoritative effective config, resolver receipts, artifacts, and transition evidence | Upstream launcher/Loader integration | Not implemented; no runtime-proof claim |

## DAL-025 acceptance closure

| Criterion | Evidence | Result |
| --- | --- | --- |
| Candidate paths are fixed at startup inside a real linked worktree and may not traverse links or reserved metadata | Coordinator path/worktree validation tests | Pass |
| Inactive staging stays separate from loaded source | Prepare/status assertions and source-no-write approval test | Pass |
| Candidate application cannot proceed, including with a staged digest or approval | `CANDIDATE_ADMISSION_QUARANTINED` unit test; unchanged live-file assertion | Pass |
| `hmr/reload` proves replacement Fiber readiness | Exact DSH source trace plus opt-in failed-start probe | Fail upstream; admission quarantined |
| Event-time disk digest identifies the imported multi-file closure | Exact DSH source trace plus opt-in hybrid-closure probe | Fail upstream; admission quarantined |
| Evaluation uses an authenticated ready candidate generation | Authoritative DSH producer and evaluator Phase 3 probe | Not implemented; no candidate-eligibility claim |
| No DSH core patch, live candidate write, or automated promotion occurs | Code-owned quarantine; disabled bundle row; operator contract | Pass |

## Observed commands

```text
CI=true pnpm run typecheck
CI=true pnpm exec vitest run tests/plugin-modes.test.ts tests/init.test.ts
CI=true pnpm exec vitest run tests/controller.test.ts tests/init.test.ts tests/reset.test.ts tests/cli.test.ts
CI=true pnpm exec vitest run tests/runtime-generation.test.ts tests/controller.test.ts tests/plugin-modes.test.ts tests/e2e-provenance.test.ts
CI=true pnpm exec vitest run tests/e2e-summary.test.ts tests/e2e-topology.test.ts tests/execution-receipt.test.ts tests/branch.test.ts
pnpm dal capsule check capsules/dal-v0-contract.json
pnpm dal capsule check capsules/dsh-adapter-boundary.json
CI=true pnpm run check
DAL_DSH_HMR_CHECKOUT=<pinned-local-checkout> pnpm exec vitest run tests/hmr-candidate.test.ts tests/plugin-modes.test.ts tests/clustering.test.ts
pnpm dal approval verify .dal/outbox/dec-dal-workflow-tools-image-20260901.json --action install_or_mount_plugin --scope <exact-isolated-image-scope>
docker build -f deploy/docker/Dockerfile -t dsh-adaptive-loop/dsh:0.1.1-rc.2 -t dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 .
CI=true DAL_E2E_TOPOLOGY_PROBE=1 pnpm exec vitest run tests/e2e-topology.test.ts
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <deterministic-grader-command>
pnpm dal verify run --runner docker --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json --command <out-of-workspace-denial-command>
```

Historical pre-attestation recorder source-gate result: typecheck and build passed; 32 test files passed with 197 tests and 6 opt-in skips; all capsules validated; policy, core evaluation, and benchmark scorecards passed with no hard stop. The focused run-mode bridge proof passed 18 tests across recorder and initialization coverage. New controller estimates additionally require DAL-024 attestation.

Historical HMR source-gate result: typecheck and build passed; 33 test files passed with 199 tests and 7 opt-in skips; all capsules validated; policy, core evaluation, and benchmark scorecards passed with no hard stop. That result did not await replacement Fibers or test multi-file imported-closure identity and is not current admission evidence.

Historical HMR-loop focused result: 23 tests passed with 5 unrelated skips across the coordinator, run recorder, bundle, schema, and clustering suites; typecheck passed. The opt-in real composition case loaded `@deepseek-ai/cordis-plugin-hmr` 1.0.17, Loader 1.0.3, and Timer 1.1.4 from local DSH identity `b6589bc9f3896ce742c1d53c03c32e04b542e735`, observed one reload and a later baseline reload. It did not prove readiness at the event or the runtime's imported closure. The executed built-artifact SHA-256 digests were HMR `822672a70baa81b95bd437275bfdcf6235702f960e03f8c4418588255bc2a880`, Loader `68722da3bd09e32e23165a83de3728b3cb9fef118153912028af980dfaabc7d2`, and Timer `aab5832ebcefccd223b16ff3e8f09ca611841f53352c8439ea3acf7cc11ad002`; no profile or DSH source was changed.

Required HMR-loop task feedback validated and ingested at `.dal/store/fb-hmr-adaptive-plugin-loop-20260904.json`; feedback digest `875e22dbbcc4778a227c726d95f49f3aeb8c6a20a5f745b7add65498b0182e3c`.

Historical combined-stack post-review result: the runtime-generation/HMR integration suites passed 55 tests with 1 opt-in skip; the real pinned Loader/HMR composition run passed all 38 selected tests; and the complete repository gate passed typecheck, build, 34 test files with 219 tests and 7 opt-in skips, all capsules, policy, core evaluation, and benchmark evaluation with no hard stop. Those checks exercised the superseded admission design. They did not prove replacement-Fiber readiness or imported multi-file closure identity and are not current admission evidence.

Required combined-stack task feedback validated and ingested at `.dal/store/fb-hmr-runtime-generation-stack-20260904.json`; feedback digest `74fbd036c9899a76ddd914279666d193dd9b72dc21827ead525b2beabfa2feb3`.

The final security-review record superseded that preliminary combined-stack record at `.dal/store/fb-hmr-runtime-generation-stack-review-20260904.json`; feedback digest `77d13779e852bceb02180ba5dd770aa3c0b6f4319305f31dcbdf74cce6c5590b`.

After PR #5's content-equivalent squash merge, the three HMR-only commits were rebased onto merged `main`. The pre- and post-rebase feature trees matched, two-dot and three-dot comparisons agreed on the same 37-file HMR surface, and the complete repository gate again passed 219 tests with 7 opt-in skips. The merged-base feedback superseded the pre-main-rebase record at `.dal/store/fb-hmr-main-rebase-20260904.json`; feedback digest `3f80228f79419ed70bc06844661036e4fafdab58f3e360ed3d86fe4f2e97f80e`.

Current quarantine correction result: three focused suites passed 27 tests with 6 opt-in skips; the opt-in real-DSH coordinator suite passed all 6 tests, including failed-start and hybrid-closure probes; and the complete repository gate passed typecheck, build, 34 test files with 214 tests and 7 opt-in skips, all capsules, policy, core evaluation, and benchmark evaluation with no hard stop. Final focused review reported no findings. The correction removes live publication and approval execution, makes generation state runtime-private and non-overridable, and prevents the production recorder from trusting mutable in-process candidate state.

Required correction feedback validated and ingested at `.dal/store/fb-hmr-readiness-admission-20260905.json`; feedback digest `630b637e5f6f01a68b108493e2019a75e99f6f42a3ed675b124a76f3ee8ea49e`.

The pre-reset feedback records named in earlier revisions were intentionally removed by the approved rebaseline; their provenance remains in git history and `.dal/resets/reset-23690aca-134b-415f-8e4a-562ed65bdd6c.json`. Current feedback is stored at `.dal/store/fb-run-controller-observation-path-20260902.json` with digest `9125c3ed2fa15dc339e08ecb839ba409905fb1653936c1a4a4003c3926180c84`.

Historical latest-image result for the 2026-09-01 baseline: image `sha256:1adcf95dedf922eaf182fefee0d4ddcaf90fed00eaa2eb947bfe99f7f97f64d9` was rebuilt after exact approval verification. The live three-container service/grader topology passed; the deterministic grader passed under `landlock-run` with full enforcement; an attempted `/root` write was denied. This is not current-image proof for the present source tree.

## Historical artifact refresh

The Dockerfile installs `dal-workflow-tools@0.1.0` globally into the isolated image. The user explicitly approved the previously stated exact scope, recorded as `dec-dal-workflow-tools-image-20260901`; `pnpm dal approval verify` passed immediately before the Docker build. The decision authorized only the local isolated image and did not authorize a shared host profile, G2 mounting, optimization-candidate application, or external data transfer.

Approved scope:

```text
install dal-workflow-tools@0.1.0 source-sha256=a026f79e4dc063c0e2e583a2238fc5f10bcf6c854ded05f8e6c9ecc8934ae7e7 into isolated Docker image dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 via deploy/docker/Dockerfile; no shared host profile
```

Scope SHA-256: `85af710aa467e4a339020be249b522f509e5f95ada5ec201db08939209087d55`.

Resolved parent manifest: `node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`. The Dockerfile still names the mutable tag; pin the digest in source before distributing the image.

## Explicit non-evidence

- No model-backed benchmark batch or provider request was run.
- The benchmark image was not rebuilt for the current source tree.
- No G2 plugin or DAL workbench plugin was installed or mounted into a DSH profile, and no repository/production optimization candidate was applied. Candidate writes occurred only in disposable test worktrees.
- Generic run ingestion validates `candidate_generation` consistency but does not independently authenticate an HMR admission receipt or grant application/promotion authority.
- Candidate provider egress remains not destination-allowlisted; topology proof is not credential-egress confinement.
- The latest-image probes do not establish model compliance or a general OS-sandbox guarantee beyond the exercised Linux container.
