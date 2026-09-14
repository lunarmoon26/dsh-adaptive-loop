# Action Fusion: opportunity screen and proposed contract

Status: **Inactive orchestration prototype implemented; native integration and
activation remain proposed.** Mode: optimization/design, not model research.
Design change: `chg-action-fusion-design-20260914`.
Work item: [issue #14](https://github.com/lunarmoon26/dsh-adaptive-loop/issues/14).
This document owns the proposed behavior; current capabilities remain governed by
[the spec](spec.md), machine schemas, and [the pilot contract](skillsbench-paid-pilot.md).
It grants no runtime, transfer, plugin-mount, or candidate-application approval.

## Inactive prototype slice

### Inactive native-adapter slice

Change: `chg-action-fusion-native-adapter-20260914`. Scope: concrete binding to
the already installed native tools API, without plugin registration, activation,
dependency upgrades or upstream source edits. Acceptance criteria:

- AC-N1: Bind native `ToolRuntime.execute` and `ToolRunContext` directly, retaining
  agent/root/parent identity, cancellation, result details and context receivers.
- AC-N2: Constrain child targets and reject identity substitution; never invoke
  filesystem/shell handlers directly or introduce a tool-dispatch callback API.
- AC-N3: Default disabled; explicit enable remains blocked before side effects
  until a supported durable private child-event path and native qualification exist.
- AC-N4: Compile against DAL's exact installed tools dependency, test the bridge
  with synthetic service doubles, and distinguish that from native integration.
- AC-N5: Preserve all existing gates and report the missing durability primitive
  as a blocker, not a successful adapter activation or performance result.

The implemented slice is **dispatch-only**. See the
[adapter boundary](../prototypes/action-fusion/native-adapter.md). A working
end-to-end native adapter remains blocked: source inspection found no public
append option for the session event envelope's `ignorable` marker, and flush
participation alone cannot establish exact-session durable ownership. No second
session writer, event-catalog mutation or independent archive is introduced to
bypass those constraints.

### Initial core slice

Change: `chg-action-fusion-prototype-20260914`. The approved implementation slice
is an unregistered orchestration core with injected dispatcher and private evidence
ports, synthetic tests, and a local unreviewed Crunch handoff. Native DSH binding,
durable journal/replay integration, plugin packaging, registration, and comparison
gate implementation remain outside this slice. No boolean option is an approval
or runtime-attestation receipt.

Acceptance criteria:

- AC-P1: Disabled by default; no CLI, plugin entrypoint, profile or tool registration.
- AC-P2: Strict bounded edit/write plus foreground command inputs; no extra keys,
  escalation, environment overrides, arbitrary tool names, queues or retries.
- AC-P3: Injected authoritative dispatch receives parent/root/session identity and
  cancellation for both children; command starts only after accepted mutation and
  awaited evidence. No direct filesystem or shell effects in the core.
- AC-P4: Separate private start/settle/skipped evidence; evidence failures block
  advancement, and thrown/denied operations never imply physical rollback.
- AC-P5: Deadline/cancellation checks at operation boundaries; await started work,
  preserve bounded native output/context, and classify command failure explicitly.
- AC-P6: Synthetic tests cover these invariants; native policy/CAS/sandbox and
  durability remain unqualified until separately approved integration.
- AC-P7: Crunch handoff remains local, unreviewed and unapplied; no extra attempts,
  metric/split changes, model calls or manufactured usage/approval evidence.

Implementation: [inactive core](../prototypes/action-fusion/core.ts),
[prototype boundary](../prototypes/action-fusion/README.md), and
[synthetic tests](../tests/action-fusion-prototype.test.ts). Sixty-two focused
tests pass, including the review regressions for input snapshots, readiness
cancellation, and skipped-command evidence after context-forwarding failure.
These do not qualify a deployed DSH seam, durable sink, sandbox, or research gain.

## Scope and design-task acceptance

The original design slice screens privacy-safe evidence, traces native DSH seams,
and defines a bounded experiment contract. The subsequent inactive prototype is
described above; neither slice contains a plugin or comparison-gate implementation.

- AC-D1: Pin inspected sources and distinguish source feasibility from runtime proof.
- AC-D2: Identify known opportunity counts and unknowns without inspecting raw traces.
- AC-D3: Specify sequencing, authorization, partial success, evidence, and test gates.
- AC-D4: Preserve the existing lean control, skill-only gate, budgets, and approvals.

## Evidence screen

DAL source baseline: `lunarmoon26/dsh-adaptive-loop@c2224f227f7e7be296c91c2aad93cd8a1c9d1c7d`.
The committed feedback below is privacy-safe but has pending human review; it is
diagnostic input, not approved provider-facing optimization evidence.

| Source | Directly recorded observation | What it does not establish |
| --- | --- | --- |
| [Paid baseline feedback](../.dal/store/fb-skillsbench-paid-baseline-20260911.json), lines 79–93, 156–176 | One failed run, 12 completed provider responses, 15 tool calls; separate artifact diagnostic passed 3/3 checks | A valid completed control, fusion eligibility, or permission to reuse the failed reservation |
| [Lean feedback](../.dal/store/fb-skillsbench-lean-profile-20260911.json), lines 151–175 | Native catalog shrank from 25 to 8 tools, definition bytes from 26,686 to 7,969 | Model-turn savings, paid effectiveness, or task-quality gain |
| Issue #14, reviewed as a public planning summary | Six of 12 responses reportedly led only to goal/todo calls; exporter written at response 7, executed at 9, checked at 10 | Six fusible rounds; bookkeeping removal and mutation/command fusion are different mechanisms |

The completed local Crunch batch supplies nine successful experiment invocations,
including baseline and best-candidate reproduction. It is not a paired harness
experiment: model candidates changed, and its safe summaries do not report
dependency-reviewed fusion boundaries. No private trial source, command arguments,
raw observations, labels, or traces are copied into this document or DAL feedback.

**Screen result: opportunity unknown, not zero.** No defensible eligible-pair count
is available from these summaries. In particular, execution after writing an
exporter is not automatically eligible if its command depends on intervening results.
The historical standard-run overhead cannot estimate residual opportunity in lean.

Before a live treatment comparison, a supervisor-reviewed aggregate from a valid
lean control identifies total model responses, tool operations, candidate boundaries,
eligible boundaries, rejections by reason, and unresolved boundaries. Eligibility
requires that the exact follow-up is knowable before the mutation result and that
the unfused boundary actually requires another model response. Same-response tool
batches, result-dependent repairs, and observation-dependent command choices do not
count as avoidable rounds. Never derive eligibility from tool totals alone.

Raw traces remain local and unread in this task. Producing that aggregate from raw
material requires a separately authorized local review; the aggregate contains
counts and closed-category reasons, not arguments, outputs, or transcripts.

## Source feasibility and integration seam

Inspected read-only, without runtime activation or external benchmark reproduction:

- `NVlabs/SoL-Pi@d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0`:
  `src/sol-pi/extensions/action-fusion/then-run.ts:95–125` sequences mutation and
  command and retains mutation on command failure. Lines 50–67 check two post-edit
  hashes, not an approved preimage CAS. The direct bash invocation at 110–113 is
  not the DAL integration seam. Preserve MIT attribution if code is adapted.
- `deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26`:
  `packages/core/tools/src/index.ts:1318–1351,1453–1495,1522–1566` exposes
  `ctx.tools.execute(...)` and re-enters policy, approval, guards, and scoped tool
  visibility for nested dispatch. The policy fallback is allow: required policy
  composition must be verified, not inferred from using the dispatcher.
- That DSH source's `packages/fs/fs-observation-policy/src/index.ts:61–94,116–129`
  owns read-before-edit and observed-version guards. The existing `edit`/`write`
  handlers preserve session path handling and sandbox policy. Omitting the
  observation-policy plugin changes semantics; fusion does not fabricate reads.
- `packages/shell/tool-bash/src/index.ts:329–388` owns shell policy, environment,
  foreground cancellation, and background-job handoff. Fusion excludes background
  mode. Nonzero exit or timeout can occur in a non-error dispatcher result.
- `packages/core/agent-loop/src/tool-calls.ts:262–289` owns top-level durable
  call/result appends. Nested `ctx.tools.execute` emits runtime notifications but
  does not automatically append separate durable child records. Nested presentation
  metadata is suppressed (`packages/core/tools/tests/tools.spec.ts:554–571`).
  PTC appends its own nested events (`packages/core/tools/src/ptc.ts:498–544`);
  its run-code-specific event types are not a generic fusion evidence API.

**Feasibility verdict: adapt a distinct composite tool, not a dispatcher interceptor.**
Use `defineTool`/`ctx.tools.register` and dispatch only fixed existing leaf tools.
Each child carries a distinct call ID, the parent's root ID/token, the same agent
and session, and propagated cancellation. Forward accepted additional contexts
through the existing `exec.deferContext` seam. Do not invoke handler bodies or
filesystem/shell services directly. Omit concurrency-safe scheduling; do not add
a second per-path queue that can deadlock with existing policies.

This is a source-checkout finding, not proof that the installed DSH release has
identical APIs. Exact runtime/package identity, policy-wrapper re-entrancy, and
durable child-event integration remain native keyless qualification gates.

## Proposed observable behavior

One optional, default-off pilot-local tool accepts exactly one existing edit or
write operation and one preselected foreground validation command. Exact tool
name and wire schema remain unassigned until the version-pinned seam is qualified;
no current tool schema changes. There is no workflow DSL, arbitrary child tool
selection, recursion, automatic repair, retry, rollback, or added goal/todo tools.

1. Validate the bounded request and required policy/evidence capabilities before
   side effects. Freeze the command before executing the mutation. Do not expose
   new escalation, environment, timeout, or path privileges through the wrapper.
2. Recheck cancellation and dispatch the mutation through existing tool policy.
3. Persist its separate outcome before considering the command. Mutation denial,
   failure, cancellation, or evidence failure skips the command. A post-policy
   denial can follow a physical mutation: record partial/uncertain effects rather
   than claiming nothing changed.
4. Recheck cancellation; independently dispatch the exact foreground command through
   current policy. Parent approval does not authorize the child implicitly.
5. Await command settlement and resource quiescence before completing the parent.
   Classify exit code, timeout, abort, and sandbox denial explicitly; an ordinary
   dispatcher return or a success-looking string is not validation success.
6. Return a combined model-facing observation while retaining separate operation
   evidence. Follow-up failure retains the mutation. Cancellation between operations
   leaves the mutation, records the skipped follow-up, and does not enqueue later work.

The operation preserves native path aliases, observed-version checks and output
limits. It promises neither a transaction across operations nor isolation from
unrelated external writers. Existing local filesystem version checks are not an
OS-level cross-process CAS. No speculative rollback or destructive cleanup occurs.

### Evidence and failure boundary

Define plugin-owned start/settle evidence before implementation, with parent/root/
child linkage, operation kind, accepted result status, physical-effect uncertainty,
exit/timeout/cancellation facts, and native truncation/readback references. Do not
forge top-level model tool calls or reuse PTC-specific event names. Exactly-once
effect execution across crashes is not promised; interrupted work is incomplete
and never automatically replayed.

Evidence unavailability before dispatch blocks side effects. A failed settle write
after mutation blocks the command and leaves an incomplete/uncertain record;
after command execution it blocks a completed-trial claim, not reality's effects.
Cancellation follows the same settled/unknown distinction. No detached child is
accepted as a completed validation. Native foreground cleanup is qualified with
adversarial tests; arbitrary shell descendants are not presumed contained.

Native detailed execution evidence stays in the existing private local boundary.
DAL and provider-facing projections contain only validated counts, statuses,
digests, and references—not raw commands, source, results, or transcripts. Existing
recorders do not automatically understand new child events: independent evidence
and replay/consumer integration are acceptance requirements, not assumed behavior.
Graders consume authoritative artifacts, never the fused success summary.

## Qualification and comparison gates

| Gate | Required evidence before advancing |
| --- | --- |
| Disabled control | Default profile/catalog unchanged; no registration, hidden model calls, or activation when disabled |
| Sequencing | Mutation success, rejection, and post-policy rejection; command nonzero exit; preserved partial results; immutable preselected follow-up |
| Native boundaries | Existing edit/write/bash dispatcher policy denials, read-before-edit, stale version, path aliases, sandbox denial and missing backend fail closed |
| Lifecycle | Cancellation before start, during mutation, between operations, during command; real timeout; started-child quiescence; interrupted evidence and no replay |
| Evidence | Separate authoritative child records, skipped command, truncation/readback retention, independent artifact grader, no leaked detailed data in DAL projection |
| Native integration | Exact runtime/profile/plugin digests; actual fused path on deterministic keyless fixtures; re-entrant policy composition; no core/shared-profile changes |
| Opportunity | Reviewed eligible lean-control boundaries and counterexamples; no headroom means no live treatment, not invented counts |
| Paired treatment | Fresh valid lean baseline versus lean plus fusion; fixed task/model/skill/grader/budget and only the declared harness delta |

The native fixtures demonstrate mechanism behavior, not model uptake or efficiency.
Any installation/mount for even a keyless integration requires separate exact
approval. Source/unit-test work does not authorize activation.

The current `benchmarks/skillsbench-pilot/live.ts:259` comparison gate requires
matching harness context and different skill bytes. Leave it unchanged. A separate
proposed harness-treatment comparator binds control/treatment artifacts, allows only
the declared harness delta, and requires identical skill bytes and other controls.
Freeze development and transfer selections before results; transfer evidence never
feeds repairs. The failed historical baseline remains diagnostic only.

The falsifiable prediction is fewer actual model responses at unchanged independently
verified task correctness, with both operations still executed and observed. Measure
fusion eligibility/uptake, completed trials, tool operations, elapsed time, and actual
reported input/output/cache usage, including nested model work (expected none).
Unknown usage stays unknown. Keep reservations, priced usage estimates, and billing
separate. Unused fusion or equality is not improvement. One pair is a feasibility
diagnostic, not broad reliability evidence. Capability thresholds, sample size, and
promotion policy require supervisor agreement before any paid or subscription run.

## Decision and next gates

The bounded inactive orchestration prototype is implemented after contract review;
no full SoL-Pi port, observation archive, reducer model, compactor, swarm, or
controller increment is included.
The immediate unresolved items are reviewed lean opportunity counts, the deployed
DSH seam/version match, and the durable child-evidence design. Native integration
and live treatment each retain their separate approvals. Missing headroom, invalid
evidence, or insufficient capacity stops advancement. No improvement or deployment
claim follows from this design slice.
