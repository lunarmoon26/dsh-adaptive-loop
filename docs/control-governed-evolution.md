# Control-Governed Harness Evolution

Status: Controller observation foundation implemented; governor, response model, predictive selection, canary, and rollback control proposed
Change: `chg-control-supervisor-foundation-20260902`
Semantic owner: this document
Exact persisted syntax: [`../schemas/controller-policy.v1.schema.json`](../schemas/controller-policy.v1.schema.json) and [`../schemas/controller-state.v1.schema.json`](../schemas/controller-state.v1.schema.json)

## Research question and claim boundary

The research question is whether a run-to-run, control-governed harness evolution loop can improve sample efficiency and practical stability relative to always-triggered reflective or evolutionary optimization under the same model, task, grader, editable surfaces, and evaluation budget.

The implemented foundation does not establish that claim. It provides an offline state-estimation contract over repeated task batches. It is accurately described as a run-to-run observation layer, not PI control, iterative learning control, model predictive control, formal stability, autonomous self-improvement, or a control-barrier-function proof.

## Two separate state machines

The task-class supervisor and candidate proposal lifecycle have different identity and authority:

```text
Controller observation (task class + generation + batch)
  run records -> compatible batch -> metric estimates -> immutable state

Improvement proposal (one candidate)
  observed -> normalized -> human_reviewed -> proposed -> sandbox_evaluated
           -> awaiting_decision -> approved | rejected -> applied -> measured
```

A later supervisor may recommend entering diagnosis or search, but it does not replace proposal transitions. Promotion and candidate application remain human-governed sensitive operations.

## Controller policy

A controller policy is human-authored, schema-valid, privacy-safe configuration. It names:

- one policy identity and creation time;
- one logical `task_class` and exact run-record `task_set`;
- the versioned estimator (`dal-wilson-score-v1`);
- one or more uniquely named proportion metrics;
- each metric's observation source, target, deadband, and minimum sample count.

Version 1 supports three explicit denominators:

| Source | Success | Failure | Excluded |
| --- | --- | --- | --- |
| `harness_outcome` | run outcome is `succeeded` | `failed`, `blocked`, or `aborted` | none |
| `business_outcome` | business status is `passed` | business status is `failed` | missing or `unknown` |
| `check` | the named deterministic check has `pass: true` | the named check has `pass: false` | run does not contain that check |

Failure-cluster member count is not a success-rate denominator. A later pressure estimator may join cluster fingerprints to eligible task/check populations, but it must not infer success from absent failure records.

## `dal control estimate`

```text
dal control estimate --policy <controller-policy> --batch <batch-id>
                     [--runs <directory>] [--store <directory>]
```

The command:

1. validates and privacy-scans the controller policy;
2. reads and validates run records from the selected store;
3. selects records with the exact policy task set and requested non-null batch ID;
4. requires every selected run to share one normalized measurement context and one harness generation;
5. estimates each configured binary proportion with a two-sided 95% Wilson score interval;
6. marks each metric sufficient only when its included sample count reaches its configured minimum;
7. marks the state `ready` only when every metric is sufficient, otherwise `insufficient_evidence`;
8. derives the estimate timestamp from the immutable inputs and binds the state ID to the complete canonical snapshot rather than the wall clock; and
9. publishes one exclusive JSON state file, returning `idempotent` for an identical retry and rejecting conflicting content.

Measurement context binds task set, environment snapshot, tool versions, model identity, grader version, context-policy digest, and inference parameters. Generation identity binds prompt, harness, model-patch, and harness-pin digests. Seeds remain observations rather than context so different declared rollouts can contribute to one compatible batch.

The command performs no model call, network request, proposal transition, branch selection, sandbox execution, budget mutation, candidate application, or profile change.

## Research protocol

Future experiments keep fixed:

- backbone model and inference parameters;
- runtime and tool versions;
- task distribution and explicit task/check eligibility;
- grader and sealed holdout;
- editable surfaces and immutable anchors;
- total evaluation and adaptation budgets.

The minimum comparison set is static harness, always-triggered greedy reflection, existing UCB branch search, PI-governed greedy search, and the eventual full predictive controller using the same proposer. Capability, sample efficiency, regressions, generation churn, edit reversals, cost, complexity growth, and response-model calibration are reported separately.

The next accepted increment may add deadband, hysteresis, leaky integral state, dwell time, saturation anti-windup, and bounded budget recommendations. Response learning and one-step predictive selection remain later increments; the MPC name applies only after an explicit edit-response model, constrained objective, and observe-predict-optimize-act-replan loop exist.

## Safety and non-goals

- Controller output is evidence or recommendation, never authorization.
- `maximum_budget` remains an immutable policy anchor; a governor may allocate only within it.
- Evaluator, holdout, permissions, promotion policy, audit log, and rollback mechanism remain outside optimizer and controller control.
- Mixed measurement contexts, mixed generations, duplicate run identities, duplicate check identities, and unpinned harness generations fail closed.
- Unsafe multi-surface proposals are rejected rather than silently projected into a different candidate.
- Canary deployment and executable rollback are not represented as implemented modes until a real generation deployment seam exists.
