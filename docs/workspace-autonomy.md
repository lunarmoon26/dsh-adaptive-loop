# Workspace autonomy and portable distribution

Change: `chg-dal-workspace-autonomy-20260916`
Status: The portable/replay foundation and the [versioned live text loop](live-text-loop.md)
are implemented. Arbitrary executable-plugin evolution remains proposed; HMR
quarantine and shared-profile boundaries remain authoritative.

## Accepted product direction

DAL accepts a broad workspace goal, investigates capability gaps, constructs
development probes, searches bounded skill/prompt candidates, compares frozen
generations, and retains the incumbent when evidence does not justify change.
The first live adapter uses native DSH/Codex subscription authentication. A
campaign authorizes workspace-local operations; shared profiles remain separately
governed. Native authentication stays with DSH. Subscription usage is not dollar
billing. A successful offline rehearsal is not a live-service or confinement proof.

## Research basis

The relevant Aspire is [2608.31111v1](https://arxiv.org/html/2608.31111v1),
*Can Models Self-Evolve from Vague Goals?*, not robotics ASPIRE. Sections 3.1–3.3
separate agent-selected objectives and development validation from controller-owned
evaluation and retention. In adaptive weight search, 2/30 cells produce an
above-base evaluated checkpoint and only 1/30 retains a gain (§4.3). This is not
an independent confirmation result. None of the valid harness successors exceeds
the reference numerically (§4.4); a narrow agent-created checklist can reward the
wrong proxy. The creator scaffold remains fixed within a round.

[S3Gym](https://arxiv.org/html/2608.31100v1) motivates evaluating memory policies
rather than assuming summary compression helps. [HarnessDev](https://arxiv.org/html/2609.01437v1)
motivates fixed executor identity, frozen runnable artifacts, activation evidence,
repeated comparisons, and reporting regressions and development cost.

## Target campaign boundary

The outer agent executes tasks and effects against one active generation. DAL plus
DSH is the inner evolution harness: it owns evidence, budgets, audit publication,
evaluator identity, goal hypotheses, proxy tests, candidates and read-only
development workspace state, but cannot self-promote. A separate DAL promotion
executor verifies the exact human decision, changes the pointer and owns canary
compensation. Candidate code cannot rewrite the outer controller. Same-user
filesystem permissions alone are not a confinement boundary. Executable-plugin
activation requires whole-process isolation and independent readiness evidence;
initial generations target skills and prompts.

The campaign separates development probes, adaptive qualification queries, and
sealed final confirmation. A score used for candidate selection is not untouched
confirmation. Each hypothesis links goal, observed gap, proxy, expected mechanism,
candidate and transfer evidence. Best evaluated, selected eligible and retained
results are reported separately, including raw regressions and no-change outcomes.
The incumbent remains a valid result. Search policy changes take effect only in a
subsequent frozen campaign; recursive improvement is claimed only after a measured
successor handoff.

`chg-dream-rsi-orchestration-20260927` follows Dream-RSI at the exploration layer:
one policy stays fixed while it drives online discovery, the resulting parent-linked
tree becomes a replay world, and alternative policy trajectories replay only stored
children from their observable prefixes. The bounded v1 policy family controls
branch choice, parallel batch size and finite stopping rounds; it is data, not model-
generated executable code. A human incorporates a replay winner into the next frozen
plan. This is recursive exploration-policy improvement without granting the inner
agent an authority to redeploy itself.

The workspace view is explicit as Belief, Progress and Experience (BPE). It is a
deterministic projection over campaign evidence, not mutable agent memory: Belief
reports development status and digests, Progress reports finite campaign state, and
Experience reports prior development scores. The generator sees only the
development-scoped projection; the dashboard sees only its digest-only counterpart.
A loopback DAL dashboard is an operator view and review-request exporter, never a
decision issuer or a Cordis/agent authority component.

Cold-start generations avoid the quarantined HMR path. The stock DSH launcher
writes profile scaffolding and resolves bare modules from its profile composition;
a workspace overlay alone does not provide package resolution. Workspace launch
state and immutable generation artifacts therefore have separate ownership.
Reusing the native credential provider requires explicit reviewed configuration,
not copying credentials or implicitly inheriting a home profile.
These launcher constraints apply to the wider plugin-integration target. The
implemented text loop instead uses a dedicated native-service host and has no
profile launch state or agent/tool services.

## Acceptance and closure

1. Published artifacts contain all runtime schemas/templates and resolve without
   a DAL checkout. The improvement plugin resolves the packaged CLI, not a relative
   source-tree path. Release inputs have committed versions and immutable tarballs.
2. Trusted publishing uses GitHub OIDC without an npm secret; release validation
   checks tags, ancestry, dependency versions and the supported package inventory.
3. Onboarding distinguishes scaffold presence from observed recording, native auth,
   independent grading and runtime assurance. Existing files are preserved.
4. Terminal records cannot collide with checkpoints; clustering excludes explicit
   checkpoints; bounded trace projection correlates native call identities.
5. A resumable campaign freezes policy and evidence, bounds search, preserves
   objective lineage, and reports best/selected/retained results without treating
   proxy scores or synthetic execution as promotion authority.
6. Live subscription execution requires separate operation-time authorization;
   text promotion additionally requires an exact human decision and a canary before
   retention. Missing executor capabilities remain explicit blockers, not
   fabricated receipts.

Focused contracts and machine schemas own implemented behavior. General agent and
executable-plugin integration remains in ROADMAP.md. Repository-wide closure uses
`pnpm run check` and the required validated, ingested feedback record.
