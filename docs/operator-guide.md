# Operator Guide

Status: Current for v0

## Safety boundary

`dal` reads JSON and local files, writes validated evidence under explicit local stores, and runs deterministic validators by default. A policy `allowed` result is evidence only. Purpose-specific executors exist for confined verification, fixed user-global installation, the governed proposer, the isolated benchmark e2e path, and staged HMR candidate application; each independently rechecks its confinement or exact approval at the operation. There is no generic shell/network/shared-config executor, model SDK, optimizer runtime, or plugin installer/mounter. The HMR coordinator is the sole candidate applier and can write only its startup-configured files in an isolated linked worktree.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The gate typechecks, runs Vitest, builds the CLI, checks all committed capsules, records an allowed non-executing policy decision, and emits a passing offline scorecard. It requires no credential or external service.

## End-of-task feedback

1. Copy the shape of `tests/fixtures/feedback/completed.json`, `blocked.json`, or `aborted.json`.
2. Include safe summaries and evidence references only. Never paste transcripts, arguments, outputs, source, environment values, credentials, or personal data.
3. Validate before write:

   ```sh
   pnpm run dal feedback validate .dal/outbox/<feedback-id>.json
   ```

4. Ingest the same file:

   ```sh
   pnpm run dal feedback ingest .dal/outbox/<feedback-id>.json
   ```

5. Report the stored path. An identical retry is idempotent. A changed record needs a new ID and `supersedes`; never rewrite the stored envelope.

Likely secret or PII rejection prints rule IDs and JSON paths, not matched values, and writes nothing. Correct or redact the source record; do not weaken the scanner.

## Policy decisions

Create a schema-valid `guardrail-action.v1` request, then run:

```sh
pnpm run dal policy check <action.json>
```

The default audit store is `.dal/guardrail-audit/`. Effects mean:

- `allowed`: request metadata fits a safe local v0 capability; no operation ran.
- `requires_human_approval`: current request is rejected until an exact approval is supplied, and may still remain disabled.
- `denied`: deterministic policy blocks the request.

Denied and approval-required decisions intentionally return exit code `1` after the audit record is published. Reusing an action ID with changed request or policy content fails rather than overwriting evidence. Even an identical request returns `GUARDRAIL_DECISION_STALE` when new quarantine evidence or changed/expired approval state would alter the result; issue a new action ID. Local checks are rate- and budget-bounded.

## Human approvals

An ordinary code review or proposal review is not sensitive-action approval. Use `approval-decision.v1` and verify exact action, scope, candidate digest, and time:

```sh
pnpm run dal approval verify <decision.json> \
  --action apply_optimization_candidate \
  --scope <proposal-id> \
  --candidate-sha256 <digest>
```

Plugin installation/mounting remains unavailable through dal. Shared configuration and external transfer occur only through the fixed user-global installer or purpose-specific proposer/e2e paths after their exact approvals verify. Candidate application is available only through the isolated HMR workbench below; it verifies this exact command for the staged digest immediately before writing the configured live files.

## Isolated HMR candidate loop

Mounting `@lunarmoon26/dal-hmr-candidate` is itself an `install_or_mount_plugin` operation and needs a separate exact decision. Configure it only in a workbench profile that points at a linked git worktree, never a primary checkout or shared profile:

```yaml
- id: dal-hmr-candidate
  name: '@lunarmoon26/dal-hmr-candidate'
  config:
    workspaceRoot: /absolute/path/to/linked-worktree
    entry: plugins/example/src/index.ts
    files:
      - plugins/example/src/index.ts
      - plugins/example/src/config.ts
    approvalFile: .dal/outbox/dal-hmr-candidate-approval.json
    approvalScope: prop-example-candidate
    dshVersion: 0.1.1-rc.2
    profile: isolated-workbench
```

The profile values fix every writable path before the agent runs. Keep the coordinator package outside `files`; every listed file must already exist and may not traverse a symlink.

1. Call `dal_candidate_prepare` with one candidate ID. It copies the live files to `.dal/hmr-candidate/`; it does not touch the loaded plugin.
2. Edit only the staged copies, then call `dal_candidate_status`. Use its `staged_sha256` in a human `apply_optimization_candidate` decision whose scope exactly matches `approvalScope`, saved at `approvalFile`.
3. Call `dal_candidate_apply`. It invokes `dal approval verify` at the operation, publishes dependencies before the entry file, and waits for a successful matching `hmr/reload`. Approval mismatch, failed activation, unrelated reload, or timeout cannot admit the candidate; activation failure restores the prior bytes.
4. End that session. Evaluate only in a newly created session whose final run record reports `context.candidate_generation.evaluation_eligible: true`. Any successful HMR reload during the session makes the record ineligible.
5. On rejection, call `dal_candidate_reject` and wait for the prior digest to reactivate. On acceptance, a human reviews the worktree diff and commits it; no dal tool promotes or commits.

The coordinator intentionally handles plugin source and imported configuration modules, not profile YAML, skills, or `AGENTS.md`. Those remain proposal surfaces with their existing human application path.

## Offline evaluation and scorecards

Run the reviewed suite in the policy-configured store:

```sh
pnpm run dal eval run tests/fixtures/evaluation/v0-suite.json
```

The runner verifies suite, fixture, policy, and target identities; executes deterministic local validators; computes task success, test pass, policy precision/recall, blocked-dangerous-action, human override, cost, and regression metrics; and publishes one immutable JSON scorecard. It makes zero external requests and records no model-judge result.

Use `--store` only for isolated test evidence. Policy quarantine lookup reads `default_evaluation_store` from `config/policy.v1.json`; authoritative hard-stop evidence must be published there.

## Quarantine and rollback

- A hard stop caused by a post-change regression selects `rollback`; other hard stops select `quarantine`.
- A policy check whose target SHA-256 matches a hard-stop scorecard in the configured evaluation store is denied. An unreadable or invalid quarantine evidence store fails closed.
- The scorecard path never changes its target. The isolated HMR coordinator can restore its in-memory pre-candidate snapshot; every other rollback remains a human repository/dsh procedure with recorded evidence.
- A hard-stopped digest remains permanently unusable in v0. Release requires a corrected artifact with a new digest, a clean uncontaminated scorecard, human review, and—where relevant—a separate sensitive-action approval.
- Never delete or rewrite the triggering scorecard or guardrail decision to manufacture a release.

## Proposal transitions

The allowed order is:

```text
observed -> normalized -> human_reviewed -> proposed -> sandbox_evaluated
         -> awaiting_decision -> approved | rejected
approved -> applied -> measured
```

Transitions append actor, time, evidence, and notes. `--output` is required and must name a new direct child of `.dal/proposals/`; publication is exclusive, so neither an earlier proposal state nor another `.dal` evidence store can be overwritten. Symbolic-link output is rejected. Human stages require a human actor. Evaluated stages load the scorecard, verify embedded immutable suite/policy snapshots and current files, replay every deterministic fixture, derive metrics/thresholds/hard-stop state, hash the actual candidate artifact, and require exact proposal/candidate identity with no regression. `applied` requires an approved, current decision for the exact proposal and candidate, but v0 records state only and applies nothing.

Every proposal names the editable surface it changes. Immutable-anchor targets (`evaluator`, `sealed_holdout`, `permissions`, `maximum_budget`, `promotion_policy`, `audit_log`, `rollback_mechanism`) are rejected at validation. From `proposed` onward a falsifiable prediction is required: one statement, at least one named metric delta, and zero or more predicted regressions.

## Run records and failure clustering

Record one run per task attempt; every workspace action is summarized by artifact digests, never by raw output:

```sh
pnpm run dal run ingest tests/fixtures/runs/run-fixture-test-failure-1.json --store .dal/runs
pnpm run dal cluster run --store .dal/runs --output .dal/clusters --format json
```

Run records carry separate harness and business outcomes, structured harness-failure facts (`category`, `code`, `fingerprint_extra`), deterministic business checks, the pinned evaluation context (task set, environment snapshot, tool versions, model, prompt/harness digests, grader version, seeds, context policy digest, inference parameters), optional runtime-generation evidence linkage, artifact digests, usage metrics, evidence references, and privacy metadata. `dal cluster run` groups harness failures by canonical failure fingerprint and completed business failures by failed check IDs into separate immutable categories; completed passing or unknown business outcomes are skipped. It runs no model or classifier. Cluster identity binds the fingerprint to the run batch (`batch_id`), so re-clustering after a new batch does not collide; `--batch <id>` clusters a single batch:

```sh
pnpm run dal cluster run --store .dal/runs --output .dal/clusters --batch e2e-20260831 --format json
```

Cluster output feeds a later human-reviewed proposal; the clustering command itself changes nothing else.

## Run-to-run controller observation

After a complete batch is present in the run store, estimate its observation state with a reviewed controller policy:

```sh
pnpm run dal control estimate \
  --policy tests/fixtures/controller/controller-policy.json \
  --batch batch-control-001 \
  --runs tests/fixtures/controller/runs \
  --store .dal/demo-control
```

The policy fixes one logical task class, exact run `task_set`, runtime-generation digest profile and minimum assurance, estimator version, and explicit harness/business/check denominators. The command requires every selected run to retain its legacy harness digest and carry stable, policy-qualified runtime evidence at a canonical `repo://` URI. It validates that evidence, loads its referenced manifest, recomputes the RFC 8785 digest, and rejects mixed contexts/generations, missing or unstable bindings, assurance downgrades, unavailable/mismatched evidence, duplicate identities, and ambiguous metric sources. It records successes, failures, excluded runs, sample count, mean, and a two-sided 95% Wilson interval. `insufficient_evidence` is a valid non-authorizing state; it is not permission to invoke a proposer or spend more budget.

The estimate time derives from policy/run evidence and the state ID binds the complete canonical snapshot, so repeating the same command is idempotent. The command performs no model, network, branch-selection, sandbox, proposal-transition, candidate-application, promotion, or rollback operation. Current DSH does not produce verified manifests automatically; unattested recorder output is intentionally ineligible. See [`runtime-generation-attestation.md`](runtime-generation-attestation.md) and [`control-governed-evolution.md`](control-governed-evolution.md) for the exact claim boundary.

## End-of-day reconcile

Run phase needs nothing special: agents work and finish each task with a feedback record and, for failures, a run record. `.dal/outbox`, `.dal/store`, `.dal/runs`, `.dal/clusters`, and `.dal/control-states` are VCS-tracked, so pull first, then reconcile:

```sh
git pull
pnpm run dal feedback summary --store .dal/store --format json
pnpm run dal cluster run --store .dal/runs --output .dal/clusters --format json
```

1. Review the summary and cluster records. Cluster digests are the proposer input; raw traces never enter a model context.
2. Drive one proposal per bounded change through the staged lifecycle, naming the editable surface and a falsifiable prediction from `proposed` onward. Human stages require human actors.
3. Evaluate through the sandbox path; a hard stop quarantines the candidate.
4. Promote by committing the reviewed skill/tool/harness change to VCS yourself; HMR admission is temporary evaluation state, not promotion. Then record `applied -> measured` with measurement evidence.
5. Commit the resulting `.dal/` evidence alongside the change so the team's next reconcile sees both.

Never delete evidence to unblock a proposal: corrections are new records with `supersedes`, and quarantined digests require a new artifact digest. A reset rebaselines the whole workspace; it never unblocks a specific proposal.

## Sealed holdout

Before any candidate evaluation, commit a train/holdout split. Preferred: keep holdout case files in a private operator-owned directory (never in the workspace or VCS) and seal their digests only:

```sh
pnpm run dal seal init --cases benchmarks/tau-style-workflow/tasks --holdout-cases ~/.dal-holdout/retail --output .dal/seal
pnpm run dal seal verify --sealed .dal/seal --cases benchmarks/tau-style-workflow/tasks --holdout-cases ~/.dal-holdout/retail
pnpm run dal seal reveal --sealed .dal/seal --candidate <candidate-id>
```

The seal directory and holdout directory must be `0700` (group/world access fails with `SEAL_INSECURE`); records are `0600`. The commitment carries a Merkle root over every case digest plus a committed 256-bit seed; the seal stores holdout digests and opaque handles, never holdout content. `seal verify` fails with `SEAL_DRIFT` when any observed or holdout case changes after sealing. `seal reveal` is one-shot per seal. A workspace-only mode (`--holdout <count>`) selects the holdout from the workspace cases by seed and is weaker: holdout content stays in VCS.

## Knowledge capsules

Validate before use:

```sh
pnpm run dal capsule check capsules
```

Missing sources, digest drift, duplicate IDs, unsafe content, or an expired `refresh_after` fails closed. Refresh by reviewing canonical sources, changing the capsule version/digests/dates, and obtaining human review; never silently refresh.

## Reset / rebaseline

To discard accumulated evidence and treat the current committed snapshot of skills, plugin sources, and instructions as the new baseline:

```sh
pnpm run dal reset status
pnpm run dal reset execute --reason "Branch cut: baseline v0.1" --actor <you> --acknowledge remove-all-evidence
```

The execute step refuses to run with uncommitted evidence under the tracked stores (`RESET_DIRTY`), without the exact acknowledgement token (`RESET_ACKNOWLEDGE_REQUIRED`), or with a secret/PII-bearing reason. It removes `.dal/`, re-scaffolds the empty stores, and writes a reset receipt under `.dal/resets/` recording the pre-reset revision, the store digest manifest, the reason, and the actor. Commit the removal and the receipt — that commit is the new baseline, and all previous evidence remains in VCS history.

## Failure recovery

| Error | Operator response |
| --- | --- |
| `SECRET_DETECTED` / `PII_DETECTED` | Remove or explicitly redact unsafe source data; confirm no record was written |
| `FEEDBACK_ID_CONFLICT` / `GUARDRAIL_ID_CONFLICT` | Keep the first record; issue a new ID for changed content |
| `POLICY_REJECTED` | Inspect matched rule IDs; do not treat a review comment as an override |
| `EVALUATION_HARD_STOP` | Keep target unchanged; follow quarantine/rollback procedure |
| `CAPSULE_INVALID` | Review source identity, digest, and freshness; publish a reviewed new capsule version |
| `POLICY_RATE_LIMIT` | Stop repeated requests and review the local audit window before retrying |
| `RESET_DIRTY` | Commit or deliberately settle pending evidence first; reset never deletes uncommitted evidence |
| `RESET_ACKNOWLEDGE_REQUIRED` | Re-run with the exact acknowledgement token; the token is the explicit human decision |

The CLI has no per-record delete command. Bulk rebaselining goes through `dal reset` (see Reset / rebaseline); retention and incident deletion are otherwise manual human-governed procedures described in [`governance.md`](governance.md).
