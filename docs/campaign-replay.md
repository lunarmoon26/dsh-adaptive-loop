# Campaign replay contract

Status: Implemented by `chg-dal-workspace-autonomy-20260916`.
Exact syntax: `campaign-replay.v1` and `campaign-replay-state.v1` in `schemas/`.

This is the deterministic, resumable comparison core of the proposed workspace
campaign supervisor. It regrades supplied workflow outputs; it does not run the
candidate, call DSH, discover hypotheses with a model, or authorize activation.

`dal campaign prepare --plan <file>` freezes a privacy-scanned plan under
`.dal/campaigns/<campaign_id>/plan.json`. Inputs are canonical repository-local
JSON references with exact byte digests. The plan names the broad goal, competing
gap/proxy/mechanism hypotheses, one fixed runtime identity, development and
qualification cases, a baseline, bounded candidates and evaluation allocations.
The built-in grader version is fixed. Hypotheses have only skill/prompt surfaces.
Every generation supplies exactly one result for each case. All input artifacts,
including baseline/candidate JSON artifacts, task definitions and observed states,
are rehashed before each replay or status operation. References are read through
the checked no-follow repository reader; noncanonical paths and duplicate identities
are rejected. The replay artifact JSON is a fixture identity, not executable code.
Each JSON file is bounded to 1 MiB and unique referenced inputs to 32 MiB in total.

`dal campaign replay --campaign <id> [--steps <count>]` grades up to the requested
number of additional candidates (all remaining by default). Baseline evaluation
consumes one query per case; every candidate consumes the same number. Allocation
is checked before preparation; an oversized plan is rejected, not truncated.
Partial replay resumes with deterministic, exclusively published chained snapshots.
Concurrent replay is idempotent because no external effect executes. History and
derived scores are recomputed from pinned inputs on every read; corruption, gaps,
unknown history files and source drift fail closed. This is not exactly-once
external execution or an authenticated log against a same-user adversary.

Selection uses strict task-pass proportions on qualification cases. Development
results are reported separately and never substitute for qualification. A candidate
is eligible only when it preserves every baseline-passing qualification case and
strictly improves the qualification mean by at least `minimum_gain`. Best evaluated
can be ineligible. Ties keep the earlier declared candidate. `simulated_retained`
is the selected candidate or the baseline; actual `retained_generation` always
remains the baseline and `activation_authorized` is always false. No policy or
result can opt into live execution. All results carry `evidence_kind: replay`.
Qualification is selection evidence, not an untouched final holdout. No sealed
holdout files are accepted as a supported evaluation role.

`dal campaign status --campaign <id>` validates and reports current replay state
without publishing a new snapshot. Reports include best evaluated, selected
eligible, raw deltas, regressed case IDs, consumed evaluation queries and explicit
live-executor/activation blockers. No raw task, state, artifact or tool content is
copied to snapshots.

## Verification

`tests/campaign-replay.test.ts` covers interrupted/resumed replay, source and
history drift, deterministic idempotence, budget limits, duplicate cases, proxy-only
gain, qualification regression, no-op incumbent retention and non-authorizing
results. This verification does not establish subscription execution, candidate
quality, runtime attestation, confinement or automatic deployment. Those missing
pieces are explicitly tracked in `ROADMAP.md` rather than implied by replay.
