# SkillsBench geometry pilot

## Pilot-local lean profile

Change: `chg-dal-skillsbench-lean-profile-20260911`.
Acceptance: the native DSH catalog contains exactly bash, read, read_image,
write, edit, glob, grep and skill; no goal/todo, delegation, workflow, web,
background-job or duplicate-editor tools. The bash tool's `run_in_background`
option is disabled because the job-management tools are absent. read_image remains bundled with the
filesystem provider; the text-only gateway still rejects image payloads.

Select `--harness-profile lean` on `run.ts rehearse` or on every `live.ts`
prepare/run invocation. The default remains `standard`, preserving its original
composition. The lean overlay changes only this container's pilot composition,
not DSH core, installed/shared profiles, task instructions, skills, grader,
provider/model, permission or sandbox services, or budget accounting.

The rendered patch and profile implementation are manifest-bound. Changing the
profile invalidates an existing approval and changes comparison context;
standard-versus-lean is not a skill-only comparison. Native rehearsal checks
every recorded request header against the expected catalog and reports its byte
sizes, alongside the existing shell and selected-skill probe. No paid run or
improvement claim is authorized by creating this profile.

Change: `chg-dal-skillsbench-pilot-20260910`
Status: Local qualification and live pilot entry points implemented; live execution requires exact approval.

This is a local, SkillsBench-derived pilot, not an official BenchFlow score.
Source identity: `benchflow-ai/skillsbench` at
`9a1f4dd5f7659f75707435da3ce854b6e48321d1` (Apache-2.0).

## Fixed selection and acceptance

- Development: `threejs-to-obj`, exporting world-space geometry with the
  requested coordinate conversion. Transfer: `threejs-structure-parser`,
  exporting grouped geometry. Neither requires a GPU or a user simulator.
- Fetch only the locked files. Keep oracle, verifier and generated ground truth
  outside the candidate container. Give the verifier pristine input, not a
  candidate-modified source file. Never mount the checkout or provider keys.
- Use a fresh offline container for each oracle, no-op and verification run.
  Oracle must pass and no-op must fail on both tasks before admitting a paid
  proposal. Timeouts, verifier setup failures and missing evidence fail closed.
- DSH rehearsal uses native headless DSH and a deterministic gateway fixture
  that requests a shell probe, not an LLM. Verify the shell marker and selected
  skill bytes. Fixture success is protocol evidence only.
- Imported source and tests remain unchanged. We replace network-installing
  test.sh launchers with a pinned preinstalled pytest/numpy environment; image
  identity and this launcher are part of the local evaluation context.
- Only bounded regular output files may reach the verifier. A symlink or
  oversized tree rejects evaluation. Candidate and grader run sequentially.
- The keyless runner rejects live options. Separate `live.ts` and `budget.ts`
  entry points enforce exact transmission and extension approvals. No promotion
  or shared-profile mutation is supported; existing reservations remain intact.
  See the [paid contract](../../docs/skillsbench-paid-pilot.md).

The upstream geometry verifiers compare vertices against independently generated
ground truth. The whole-object task also checks for faces; neither establishes
complete mesh topology or general asset quality. Transfer is one public task
withheld from proposer inputs, not a statistically representative test set or a
globally secret benchmark. Start with unchanged upstream development skills;
future treatment changes only obj-exporter/SKILL.md while support files stay fixed.

## Audited exclusions

The pinned TicToc task verifier checks existence, integer-array syntax and
sorted uniqueness but no answer correctness. Empty output can satisfy it.
Dialogue-parser requires diamond choice shapes absent from its prompt.
Manufacturing normalization imposes unpublished numerical calibration thresholds.
Those tasks are not admitted. Upstream membership is not a quality guarantee.

## Commands

From the DAL root (no credentials or .env loading):

```sh
pnpm exec tsx benchmarks/skillsbench-pilot/run.ts fetch
pnpm exec tsx benchmarks/skillsbench-pilot/run.ts build
pnpm exec tsx benchmarks/skillsbench-pilot/run.ts qualify
pnpm exec tsx benchmarks/skillsbench-pilot/run.ts rehearse
```

Fetch retrieves public pinned sources. Build uses only this directory as context
and installs pinned runtime dependencies; subsequent runs have no outbound
network. Private artifacts and reports are written exclusively below
`.dal/check/skillsbench-pilot/`. Commands never overwrite earlier trials. An
explicit `--skill <repo-local.md>` on rehearsal selects exact candidate Markdown;
the default is the upstream development obj-exporter skill. No live mode exists.

Build requires the pinned local gateway image named in `source.ts`. An existing
matching build receipt is reused; a drifted receipt/image fails rather than
overwriting prior evidence. Runtime image IDs are frozen, but fresh builds are
not promised byte-identical: apt repositories and transitive Python dependencies
are not fully snapshot/hash locked. The fixed rehearsal campaign accumulates
reservations under its own namespace and can exhaust its cap; this is intentional,
not a reason to reset the ledger or rotate campaign IDs. No paid reservations are
consumed by rehearsal.

Oracle/no-op results must contain exactly the three upstream tests, with no setup
errors or skips. Pytest exit status alone is insufficient to admit a task.

## Observed local evidence (2026-09-10)

- `qualify-8NWSCz/report.json`: both upstream oracle solutions passed all three
  tests; both empty-output controls failed ordinary assertions, with no setup
  errors or skipped tests. Reports are under `.dal/check/skillsbench-pilot/`.
- `rehearse-uEATbl/report.json`: actual headless DSH executed the fixture-requested
  shell command and reported the exact obj-exporter skill digest. Shared support
  files were mounted read-only. This is not an agent solution to the task.
- Focused source/pilot/gateway tests: 132 passed. Full `pnpm run check`: 928
  passed, 7 skipped. An existing gateway timeout-status test failed once during a
  concurrent suite run, then passed in isolation and on the full rerun without
  a code change; timing sensitivity remains a verification limitation.

This local evidence predates the live entry point. No skill improvement has been
measured. The live workflow below still needs actual approved model observations.

## Live workflow (each paid phase separately approved)

1. Run `budget.ts prepare`. Its proposed cumulative cap keeps all prior
   reservations. Review the exact extension scope, then `budget.ts apply
   --approval <decision-file>`. This alone does not authorize a model call.
2. Run `live.ts prepare --batch <unique-id> --task threejs-to-obj --generation g0
   --qualification <qualify-report> --approval-id <decision-id>`. The unchanged
   upstream baseline is copied exclusively to a digest-named `.dal/candidates`
   Markdown file. Preparation returns the exact manifest and digest.
3. After approval, run `live.ts run` with the same options plus `--manifest
   <manifest-file> --approval <decision-file>`, explicitly loading the selected
   launcher credential. A reused batch fails; there are no automatic retries.
4. Run `live.ts assess --receipt <receipt-file>`. A passing baseline stops as
   `no_change_needed`. A failure requires causal review, not blind optimization.
5. For a genuine skill failure, `live.ts enroll --receipt <receipt-file>` writes
   its verified sanitized development run. Feed only that run store to existing
   `dal cluster run` and `dal optimize prepare`, then `run-metered-proposal.ts`
   using the live receipt as `--development-baseline`. Approve its exact payload
   before sending. No transfer report or verifier contents enter the payload.
6. A g1 evaluation additionally requires `--skill <staged.md> --exchange
   <exchange.json> --candidate <candidate.json>`. Preparation reconstructs the
   bounded candidate again and binds all bytes. Run `live.ts compare --baseline
   <g0-receipt> --candidate <g1-receipt>` for the same task/context. Freeze the
   candidate before preparing the transfer pair. These are single-case pilot
   comparisons, not official benchmark scores or broad reliability estimates.

All script paths above are under `benchmarks/skillsbench-pilot/`, except the
existing metered proposer under `benchmarks/tau-style-workflow/`. `run.ts` remains
keyless. Build receipts are versioned by pinned base and Dockerfile digest;
rebuild for changed source/schema provenance and requalify the new image before
preparing a live manifest. Do not reuse old approvals after any such change.
