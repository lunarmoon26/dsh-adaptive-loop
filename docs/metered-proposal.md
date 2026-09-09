# Metered Proposal Handoff

Status: Implemented. Change: `chg-dal-paid-e2e-preflight-20260907`.

The paid campaign proposal stage uses
`benchmarks/tau-style-workflow/run-metered-proposal.ts`, not the historical
direct `dal propose run` allocation ledger. That command remains supported and
unchanged, but is not the shared-cap campaign handoff.

## Contract

- Required identity: `--mode rehearsal|live --campaign ID --batch ID --provider openai|anthropic --model EXACT --provider-cap-microusd INTEGER --clusters DIR`. Optional `--runs DIR` supplies representative summaries.
- Exact models are `gpt-5.6-terra` and `claude-sonnet-5`, respectively. The driver uses the rollout's policy builder and the same fixed reviewed rates, byte/token assumption, limits, and 1024 output-token cap.
- Paths resolve against the DAL checkout containing this driver, not the invoking cwd. The ledger is fixed to that checkout's `.dal/check/spend`; no endpoint, key-file, ledger-root, runner, tool, DSH, or profile override exists.
- `--prepare true --manifest FILE` (or `--output FILE`) exclusively writes the canonical manifest and `FILE.sha256`. Prepare does not read approval files, environment keys, or `.env`, open sockets, initialize a ledger, or send data.
- Execution requires `--manifest FILE --output DRAFT`. `--verify true --manifest FILE` performs the same verification without startup or sending. Live verification/execution also requires `--approval-id dec-ID --approval FILE`.
- Verification regenerates the entire manifest from current source inputs and code. Extra fields, changed provider/model/payload, native body, rates, cap, source hashes, ledger identity, or digest sidecar fail closed. Live approval must be an approved, effective, unexpired `send_data_externally` decision whose `scope.value` is the full manifest digest and whose `scope.sha256` is SHA-256 of that digest string. Its decision ID must match the policy's approval ID. Pending approval requests are not decisions.
- The manifest binds sanitized payload and original payload digest, full native nonstreaming body, fixed endpoint, gateway policy/run identity, shared ledger root, input inventories, and driver/gateway/proposer/ledger/approval/privacy/schema source hashes. It hashes all schema JSON files without changing the shared registry. It rejects duplicate run IDs and checks repeated input projection determinism.
- The legacy native builder's mandatory budget argument is a construction placeholder only. Only the native body is projected; its output cap is lowered to 1024 before approval. The gateway reserves `(2 * canonical_body_bytes + 8192) * input_rate + 1024 * output_rate`, not an operator-declared reservation amount.
- Live starts a loopback random-port gateway only after exact approval verification. A random, ephemeral, never-logged capability authenticates the single approved body. The gateway reads only the selected environment key, after durable reservation, and forwards only to the fixed provider endpoint.
- Live budget ID is the campaign ID, exactly as in rollout. Rehearsal uses `rehearsal-CAMPAIGN` with gateway mode `rehearsal`, never fake live. Campaign IDs and batch IDs are operator-owned; this driver rejects campaign names beginning with the reserved `rehearsal-` prefix. All stages of one paid campaign must use the same campaign and provider cap.
- Same batch/provider/body retries retain the same gateway request identity, even with a new approval or output path. Existing reservations reject replay. New batches consume the remaining shared cap, and an existing cap cannot be enlarged by a subsequent request. Invalid JSON, refusal, incomplete output, missing keys, and transport failures retain the allocation; there is no refund or automatic retry.
- A complete text-only native response is parsed with the same pure parser as direct proposals and passed as an internal already-obtained-text runner to `proposeDraft`. Draft privacy/schema validation remains authoritative. Provenance uses the provider HTTPS runner, full metered manifest digest as request digest, and existing payload digest. Rehearsal identity is carried by the manifest and receipt, not a new draft schema field.
- After gateway close awaits pending outcome writes, an exclusive `DRAFT.gateway-receipt.json` records bounded gateway counters, mode, manifest digest, upper bound, and whether draft validation succeeded. It records no capability, credentials, raw provider logs, or paid transcript. Gateway completion does not imply valid proposal JSON. A failed receipt write fails the command. An interrupted process may leave a reservation without a draft or receipt; this never authorizes a replay.

These bounds are reviewed accounting assumptions, not measured provider billing,
execution attestation, optimization quality, or permission to apply the proposal.
Base digests in proposal text remain unverified human-review assertions.

## Keyless Workflow

The repository's `.dal/clusters` is initially empty. Existing input fixtures are
under `benchmarks/tau-style-workflow/dal/fixtures`; create local clusters with the
existing deterministic CLI (these commands call no model):

```sh
node --import tsx src/cli.ts run ingest benchmarks/tau-style-workflow/dal/fixtures/run-benchmark-fail.json --store .dal/check/metered-fixture-runs
node --import tsx src/cli.ts cluster run --store .dal/check/metered-fixture-runs --output .dal/check/metered-fixture-clusters
node --import tsx benchmarks/tau-style-workflow/run-metered-proposal.ts --mode rehearsal --campaign proposal-fixture-openai --batch proposal-one --provider openai --model gpt-5.6-terra --provider-cap-microusd 1000000 --clusters .dal/check/metered-fixture-clusters --runs .dal/check/metered-fixture-runs --prepare true --manifest .dal/check/proposal-fixture-openai.manifest.json
node --import tsx benchmarks/tau-style-workflow/run-metered-proposal.ts --mode rehearsal --campaign proposal-fixture-openai --batch proposal-one --provider openai --model gpt-5.6-terra --provider-cap-microusd 1000000 --clusters .dal/check/metered-fixture-clusters --runs .dal/check/metered-fixture-runs --verify true --manifest .dal/check/proposal-fixture-openai.manifest.json
node --import tsx benchmarks/tau-style-workflow/run-metered-proposal.ts --mode rehearsal --campaign proposal-fixture-openai --batch proposal-one --provider openai --model gpt-5.6-terra --provider-cap-microusd 1000000 --clusters .dal/check/metered-fixture-clusters --runs .dal/check/metered-fixture-runs --manifest .dal/check/proposal-fixture-openai.manifest.json --output .dal/check/proposal-fixture-openai.draft.json
```

For Anthropic use `--provider anthropic --model claude-sonnet-5`, campaign
`proposal-fixture-anthropic`, and corresponding fresh manifest/draft filenames.
The fixture branch in `createRehearsalUpstream` detects the tool-free proposer
task and `output_contract` and returns a deterministic valid proposal, rather
than the rollout's `get_order` tool-call fixture. It uses no credentials or
external network. Rehearsal drafts are not paid-model results.

## Live Gate

Prepare again with `--mode live`, the **existing rollout campaign and provider
cap**, a planned proposal batch, `--approval-id dec-ID`, and a fresh manifest.
Review the manifest and arrange a separate human decision for its exact digest.
Keyless `--verify true` checks that decision; it does not call a provider.
Only after authorization, the operator explicitly supplies credentials using:

```sh
node --env-file=.env --import tsx benchmarks/tau-style-workflow/run-metered-proposal.ts --mode live --campaign CAMPAIGN --batch PROPOSAL_BATCH --provider openai --model gpt-5.6-terra --provider-cap-microusd CAP --clusters CLUSTERS --runs RUNS --manifest MANIFEST --output DRAFT --approval-id dec-ID --approval APPROVAL
```

This is a parameterized, approval-gated example, not an instruction to send now.
The launcher loads `.env`; driver code never does. No paid call is part of the
test suite. Prepare only after final source changes: parser extraction and the
fixture branch change gateway image content, so the main owner must rebuild the
final image and regenerate relevant approvals. This handoff itself runs no DSH
or container and makes no claim about the previously rehearsed image.

## Evidence

`tests/metered-proposal.test.ts` covers real local HTTP rehearsals for both exact
models, live native mocks, pre-start approval failures, payload/source/policy
drift, prior-rollout shared-ledger exhaustion, fixed-cap reuse, replay denial,
invalid output/refusal/incomplete response, and no-refund behavior. Existing
proposer transport and gateway tests protect the unchanged direct send API and
generic rollout fixture behavior.

Standalone keyless prepare, verify, and rehearsal commands were also executed
for both providers using `.dal/check/metered-fixture-clusters` and
`.dal/check/metered-fixture-runs`. Outputs are
`.dal/check/proposal-fixture-openai.draft.json` and
`.dal/check/proposal-fixture-anthropic.draft.json`, each with its adjacent
`.gateway-receipt.json`. Both receipts report one completed request, a validated
draft, mode `rehearsal`, and no execution attestation. Reserved upper bounds are
79,772 and 58,704 microUSD respectively, not paid charges. These one-shot
filenames and request identities are now consumed; use fresh names for another
rehearsal, never reset the ledger to repeat one.

Focused verification: 409 tests passed across metered proposal, proposal
transport, proposal drafts, automatic proposal, proposal budget, model gateway,
and gateway runner suites. `tsc -p tsconfig.json --noEmit` also passed.
Repository-wide build, final image rebuild, paid approval, and live provider
execution remain outside this scoped verification.
