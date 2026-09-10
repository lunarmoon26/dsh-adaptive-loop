# One workspace skill adaptation experiment

Change: `chg-dal-skill-adaptation-slice-20260910`
Status: Runnable path implemented; paid adaptation benefit not measured

## Baseline finding and reason-code correction

`chg-e2e-adaptation-dev-g0-01` completed one approved live development attempt.
Unknown-effect recovery succeeded: the refund resolved successfully on a status
query. The refund goal nevertheless failed because the agent supplied `faulty`
while the hidden goal required `faulty-item`. Neither the visible task nor its
policy/tool contract specified that exact value. This observation does not support
the selected recovery-failure hypothesis, even though the mechanical baseline
assessor reports `eligible_for_proposal` for a receipt-valid business failure.

`chg-dal-partial-refund-reason-contract-20260910` corrects the benchmark-owned
visible policy: faulty-item partial refunds use the reason code `faulty-item`.
The policy is the canonical owner of that requirement, not the candidate skill.
The task goal, grader, service semantics and baseline skill remain unchanged.

Acceptance: the expected partial-refund code is available in the visible policy;
a deterministic service run using it and resolving the unknown effect passes the
unchanged grader; a different reason still fails the refund goal. Historical
receipts, manifests, assessments and paid reservations remain untouched. The new
policy changes the evaluation context and requires a fresh exact approval for any
paid run; old and new context results are not an adaptation comparison. No further
paid attempt, candidate generation or improvement claim is part of this correction.

## Question and fixed scope

Does one generated skill edit improve recovery from an unknown partial-refund
effect without breaking related workflows? Development uses the existing
`task-004-partial-refund.json` with `issue_refund=unknown` resolved as `success`.
Use the current production-like skill unchanged for the baseline. The old G0
fixture is an ablation with other obsolete instructions, not a clean baseline.

An actual baseline failure is required before proposing an improvement. Existing
ordinary-refund successes and synthetic missing-label fixtures do not establish
this failure. If the baseline succeeds, report no change needed; do not remove
tool guidance or weaken the task to manufacture an opportunity.

Preselected transfer cases are existing task 001 (full refund under unknown
refund resolution) and task 002 (booking change under unknown booking resolution).
They are held out from the proposer inputs, not claimed to be private global
benchmarks. Refusal tasks 003 and 005 are regression guards. The task, policy,
faults, grader, model, runtime and budget are frozen within every comparison.

## Missing seams this increment closes

1. A metered skill proposal binds an optimizer exchange and the actual base skill
   bytes into its approved payload. It emits a bounded `optimizer-candidate.v1`
   edit object, not merely a prediction draft. Existing reconstruction, privacy,
   base-drift and confined Markdown staging checks remain authoritative.
2. The isolated e2e runner accepts an explicit skill artifact, hashes it into the
   transmission manifest, stages those exact bytes and checks drift before a
   request. It does not overwrite the baseline skill or activate a host profile.
3. An adaptation report applies existing receipt/provenance comparison checks,
   distinguishes equality from positive gain, and reports no improvement or
   regression honestly. Neither structural candidate validity nor a passing
   unchanged control establishes improvement.

## Acceptance and non-goals

- Wrong base/exchange, invalid edits, leaked secrets, task/grader edits and
  unavailable evidence fail before staging or sending as appropriate.
- Reconstructed candidate bytes are the bytes selected by the runner; changing
  them invalidates the exact model-run approval.
- Baseline/candidate comparisons require matching task and runtime context,
  distinct candidate identities and genuine outcome evidence. Improvement needs
  a positive outcome delta, not just the existing non-regression gate.
- A known no-op outcome fails the task oracle; equality is not labelled a gain;
  a regression blocks a positive verdict. Mock proofs are never called model
  improvement.
- No new clustering algorithm, controller, provider, scheduler or promotion
  mechanism is introduced. Existing campaign budgets and exact external-transfer
  approvals remain in force. No paid call or activation is part of implementation.

Deliver one runnable path through these existing seams. A small paid demonstrator
is preliminary evidence, not a reliability estimate or autonomous promotion.

## Runnable sequence

1. Prepare and approve a development `run-e2e.ts` batch using the current skill,
   explicit `--generation g0`, `--tasks task-004-partial-refund.json`,
   `--faults issue_refund=unknown`, and `--resolutions issue_refund=success`.
   Use an isolated development run store and the existing exact model/image/cap
   controls. No G0 ablation fixture or weakened tool hint is substituted.
2. Run `skill-adaptation.ts --baseline <development-summary>`. A passed baseline
   returns `no_change_needed`; invalid evidence is rejected. Only a valid business
   failure qualifies for the skill-proposal step.
3. Build clusters only from that development batch, and prepare an optimizer
   exchange targeting the unchanged baseline skill. The metered proposer accepts
   `--exchange <file> --candidate-out .dal/candidates/<name>.md` and, for live
   skill mode, requires `--development-baseline <summary> --runs <development-store>`.
   It verifies eligibility, model/base identity, exact run-file digests and member
   enrollment before preparing or sending. Extra held-out runs are rejected.
4. Approve that exact metered proposal manifest. The returned edit object passes
   the existing structural validator and is staged exclusively as Markdown.
   Candidate JSON and optimizer verdict remain separate audit artifacts.
5. Prepare and approve evaluation with `run-e2e.ts --skill <staged-candidate.md>
   --generation g1`; baseline evaluation uses `--skill <baseline.md> --generation g0`.
   Both use identical task/model/runtime/fault/budget context. No source file or
   default profile is overwritten.
6. Freeze the candidate before transfer/regression evaluation. Both sides use the
   four held-out task IDs above with
   `--faults issue_refund=unknown,change_booking=unknown` and
   `--resolutions issue_refund=success,change_booking=success`.
   `skill-adaptation.ts --baseline <summary> --candidate <summary> --partition held-out`
   requires matching evidence, positive gain and no per-task regression. Equality
   is `no_improvement`; every result keeps `promotion_authorized: false`.

The command owners are `run-e2e.ts`, `run-metered-proposal.ts`, and
`skill-adaptation.ts` in `benchmarks/tau-style-workflow/`. Each paid phase needs its
own exact approval once its input artifacts exist; preparation does not grant it.
Keyless fixture generation is explicitly marked rehearsal and never qualifies as
a real development failure or a measured improvement.
