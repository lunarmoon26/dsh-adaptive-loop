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

## Optional Skill Candidate

Change: `chg-dal-skill-adaptation-slice-20260910`. The accepted experiment scope
is [one workspace skill adaptation](skill-adaptation-experiment.md). Omitting
both new flags preserves the prediction-draft path above.

Add `--exchange FILE --candidate-out .dal/candidates/NAME.md` to **every**
prepare, verify, and execution invocation. This mode requires invocation from
the DAL checkout root because the existing optimizer evaluator resolves
repository URIs against cwd; the driver never changes cwd. The exchange must
validate against `optimizer-exchange.v1`, target `kind: skill` with
`format: bounded_edits`, and name a canonical `repo://` workspace skill source:
an `.agents/skills/NAME/SKILL.md` path (optionally below a workspace subdirectory)
or a direct `.dal/candidates/NAME.md`. Arbitrary task, fixture, evaluator and
other Markdown paths are not skill sources. `file://` and other URI schemes
are not supported by the existing evaluator.

For **live skill mode**, every prepare/verify/execution invocation additionally
requires `--development-baseline SUMMARY --runs DIR`. The summary must be a
root-local `e2e-summary-v1` artifact. `assessDevelopmentBaseline` must report
`eligible: true`: the exact development task `task-004-partial-refund.json`,
`issue_refund=unknown` with `issue_refund=success`, generation `g0`, declared-live
isolated execution, verified metrics and receipt/run evidence, and at least one
business failure. A passing baseline means no change needed; a state-only
synthetic failure or unavailable receipt does not qualify. The validated
summary's provider/model must match the proposal gateway, and its candidate
digest must equal the exchange's actual base skill digest.

The same flag also accepts a `skillsbench-live-receipt.v1` development receipt
from the [geometry pilot](skillsbench-paid-pilot.md). That branch validates live
gateway, output, JUnit and mounted-skill evidence, requires a failed development
g0 outcome, and regenerates the exact sanitized run projection from its bound
DSH session. `--runs` must contain exactly that projection; clusters may contain
only its run ID. Model and base digest must match. Passing outcomes, transfer
tasks, g1 receipts, substituted records and missing session evidence fail closed.
This adds no generic arbitrary-task bypass to the original tau enrollment gate.

The supplied run IDs must equal the complete set of summary attempts, and each
exact file digest must match its attempt. Every cluster member and
representative, including clusters beyond the payload's projection cap, must
belong to those attempts and be present in `--runs`. Extra transfer, held-out or
nondevelopment IDs and substituted summaries under an allowed run ID are
rejected before preparing an external manifest.

`inputs.development_baseline` binds summary path/byte hash, the assessor's
evidence references, and raw file hashes for its manifest, receipts and runs.
These scientific-gate inputs stay local, outside the native payload. The driver
hashes `skill-adaptation.ts`, `e2e-summary.ts` and their receipt/run validators
into `driver_sources`; normal manifest regeneration repeats the assessment and
bindings before broker startup and before candidate publication. This gate is
not independent execution attestation and never replaces exact external-transfer
approval. Digest-bound synthetic test fixtures test validation, not real model
failure or improvement.

Rehearsal skill mode requires no actual-model baseline claim and rejects
`--development-baseline`; it uses explicit fixtures instead. The flag is also
rejected for the default prediction-draft path, whose behavior remains unchanged.

- Exchange and base files must be root-local regular files with no symlink
  ancestors, traversal, URL escapes, hard links, or env paths. Reads reject
  invalid UTF-8, oversized inputs and observed file drift. The base SHA-256 is
  computed from actual bytes and must match the exchange before preparation.
- The native payload retains literal `task: propose_one_falsifiable_change`
  and sanitized development failure clusters, restricts editable surfaces to
  `skills`, and adds `output_kind: optimizer_candidate` and `skill_target`
  containing `exchange_id`, `target_uri`, `base_sha256`, and `base_text`.
  Only allowed metric names are projected from the exchange objective. Dataset
  references and their contents, evaluator fixtures, and transfer/holdout cases
  are never retrieved or included. Operators supply only development clusters
  and summaries. Live skill proposals enforce the development-baseline gate
  above; rehearsal fixtures are not actual-model failure evidence.
- Base text is privacy-scanned. The complete request retains the existing
  64 KiB bound, fixed system instructions, exact provider/model routes, 1024
  output-token cap, campaign ledger and no-refund behavior. Supplying an exchange
  does not approve source disclosure. Live sending still requires a separate
  unexpired external-transfer decision for the exact manifest including the
  reviewed base text; the exchange's privacy flag remains non-authorizing.
- `inputs.skill` and `skill_proposal` bind the exact exchange/base byte hashes,
  paths, target identity and Markdown destination. Helper and evaluator source
  hashes join `driver_sources`. Verification rebuilds these inputs, payload and
  native body before gateway startup, then repeats after the reply and before
  candidate publication. Changing even exchange whitespace or the staging
  destination invalidates the manifest.
- Execution `--output FILE.json` is the structured candidate destination,
  outside `.dal/candidates`, not a prediction draft. Its parent and the
  `.dal/candidates` directory must already exist and be real directories.
  Existing JSON, Markdown, receipt or verdict outputs fail before sending.
  Native replies must be complete `optimizer-candidate.v1` objects including
  edits, privacy-safe and bound to the exact exchange/surface/target/base.
  No fields are relabeled, inferred or stripped, including invented model
  metadata. Edit replacements are bounded in UTF-8 bytes.
- Only schema-valid, privacy-safe, exactly matched candidate JSON is published.
  `evaluateOptimizerCandidate` then owns sequential reconstruction, metric and
  edit checks, base-content digest verification, the no-change gate and exclusive
  raw Markdown staging. An invalid edit or no-change reply can leave validated
  JSON and a separate `FILE.json.optimizer-verdict.json` diagnostic, but never
  staged Markdown. Malformed, private or mismatched replies publish neither
  candidate JSON nor Markdown. Drift detected before publication does likewise.
- The adjacent gateway receipt adds `candidate_validated` in this mode; this
  means reply schema/privacy/identity validation, **not** a passing edit verdict.
  The separate bounded optimizer verdict contains checks and artifact digests,
  not full skill text. Successful execution additionally returns
  `candidate_path`, `candidate_sha256`, and `verdict_path`. These are staging
  results, not outcome improvement, apply approval or live activation.

The controller-computed base hash is authoritative request input only. Returned
artifact digests remain unverified claims until the deterministic validator
checks actual bytes. The fixed transport instruction is unchanged.

The ordinary rehearsal fixture returns a prediction draft. Skill-mode keyless
rehearsal returns bounded native optimizer candidate JSON through the gateway's
`output_kind` branch. The reconstructed fixture was executed by isolated DSH
with matching skill bytes: protocol passed and its no-op business outcome failed.
This proves integration, not model improvement.

The completed repository gate passed 885 tests with 7 opt-in tests skipped,
plus typechecking, build, capsules, policy checks and offline evaluations.
Focused coverage includes native mocks for both exact providers, UTF-8/BOM/CRLF
byte preservation, invalid/no-change edits, output conflicts, privacy/size bounds,
excluded datasets, complete development enrollment and pre/post-response drift.
See the experiment contract for the actual paid baseline finding and why its
reason-code mismatch does not justify a recovery-skill proposal. Receipt-valid
business failure is an eligibility check, not proof of a causal skill defect.

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
