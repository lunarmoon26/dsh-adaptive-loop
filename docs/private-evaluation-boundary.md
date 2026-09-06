# Private evaluation harness boundary

Status: **Accepted boundary; no DAL runtime integration**
Related private project: `dsh-harness-evals`
Decision date: 2026-09-04

## Decision

Stateful agent evaluation is a separate system from DSH Adaptive Loop. The
private `dsh-harness-evals` project owns evaluation tasks and suite locks,
resolved trial plans, isolated runners, scenario drivers, state probes, hidden
graders, raw traces and snapshots, trial records, and aggregate reports.

DAL remains the product and control plane. It owns feedback, run records,
runtime-generation evidence, approval decisions, proposals, deterministic local
scorecards, and the narrow compatibility records that its workflows consume.
The private evaluator treats DSH, DAL, Cordis, model configuration, prompts,
tools, composition, and HMR generation as versioned subject inputs; it does not
become an authority inside DAL.

## Current integration state

At the decision date, the sibling private project supplied runner-neutral protocol v1 schemas and a
local synthetic compiler/validation fixture. DAL has no package dependency,
command invocation, data import, model call, profile mutation, plugin mount, or
external transfer for that protocol.

Existing DAL persisted schemas retain their current identifiers and semantics.
In particular, `evaluation-suite.v1`, `evaluation-scorecard.v1`,
`execution-receipt.v1`, `run-record.v1`, and runtime-generation records are not
generalized or rewritten to mirror private trial data.

## Trust and data rules

- Private tasks, holdouts, grader implementations, reference solutions, raw
  messages, tool payloads, snapshots, and traces stay outside this repository
  and its `.dal` stores.
- Subject output cannot create approval, mark evaluator evidence trusted, alter
  a hard gate, or authorize application or promotion.
- Deterministic safety failures remain hard gates. Model-grader output is
  supplemental and non-authorizing.
- Any future transfer to a provider or shared destination requires its own exact
  approval at the operation; this boundary grants none.
- A future DAL compatibility export contains only a privacy-reviewed compact
  projection plus digest references to evaluator-owned records. It never embeds
  private raw artifacts.

## Compatibility window

Protocol v1 is external and additive. DAL readers and writers continue unchanged
until a separately specified compatibility export is implemented. That future
change must define forward and rollback behavior, validate the source trial
record and privacy projection, preserve existing v1 records, and add focused
cross-repository fixtures before DAL consumes the result.

## Conformance

The boundary is preserved while:

1. `dsh-adaptive-loop` has no dependency on the private evaluator package or
   private task corpus;
2. private raw evidence is absent from DAL records and version control;
3. evaluator result ingestion cannot bypass DAL's policy, approval, evaluation,
   proposal, or promotion gates; and
4. container, DSH/HMR, and model-quality claims are made only after those exact
   integrations are exercised, not from protocol-schema tests.
