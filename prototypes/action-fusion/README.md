# Inactive Action Fusion core

`core.ts` is an unregistered, dependency-injected orchestration prototype. It is
not a DSH plugin, CLI command, package entrypoint, native adapter, or installed
treatment. Nothing imports it in production; the test suite imports it for local
synthetic verification. Its design is [the proposed contract](../../docs/action-fusion.md).
Implementation change: `chg-action-fusion-prototype-20260914`.

A subsequent [native checkpoint adapter](native-adapter.md) compiles against the
installed tools types and supplies a narrow structural extension for patched native
source. It is default disabled, source-component tested and unregistered; the old
installed runtime fails its detached probe without polluting the live log.

## Implemented boundary

`createFusionPrototype(ports, options).run(input, context)` is disabled by default.
An explicit local `enabled: true` exercises the core; it is not an approval or
qualification assertion. The required ports are readiness checking, authoritative
child dispatch, and private evidence acceptance. No concrete implementations of
those ports ship in the original core slice. The subsequent native adapter implements
dispatch, detached Session probing and exact live-writer checkpoints.
No direct filesystem, shell, network or model
operation occurs in the core.

The input contains one `mutation` (`name: edit|write`, `arguments`) and one
`command` (native `command`, `description`, `workdir`, `timeoutMs` fields). Edit
arguments are `file_path`, `old_string`, `new_string`, optional `replace_all`;
write arguments are `file_path`, `content`. Unknown fields, getters, hidden fields,
invalid/oversized strings, and timeout values outside 1–60,000 ms are rejected
before any port call. Paths are passed unchanged to the native adapter; this is
not a path fence. Escalation/environment/background options and arbitrary leaf
tool names are absent. The core does not parse arbitrary shell commands to prove
they cannot spawn descendants; native confinement/cleanup qualification remains
required. Mutation text is capped at 32 KiB per field; command/path at 4 KiB,
description at 1 KiB, native JSON result at 1 MiB per child and depth 64.

The command snapshot is frozen before readiness or mutation. Dispatch carries
distinct child IDs, the original root/parent token and agent/session identity,
and a shared cancellation signal. It does not call leaf handlers directly.
Each invocation awaits private start/settle evidence; skipped commands are explicit.
Dispatch rejection, uncertain output, evidence failure or context-forwarding
failure blocks advancement. Child native output, metadata, contexts, and spill
references remain available in the bounded private result. Physical effects are
conservatively possible once dispatch starts, including post-policy denial.
No rollback or automatic retry is claimed.

The per-instance core rejects concurrent calls instead of queueing them. The
overall deadline is at most 60 seconds and is **cooperative**: started port work
is always awaited, never abandoned through `Promise.race`. Non-cooperative ports
can exceed the deadline. An eventual native adapter must qualify timeout and
process cleanup; this core does not supply process isolation. Nonzero exits,
signals, timeouts, aborts, missing/failed sandbox facts, and background-handle
results cannot count as successful validation.

## Evidence and future adapter obligations

`Evidence` is a version-labelled **private native child-event payload**, not an
approved persisted DAL schema. It links parent/root/child identity and phase,
and can contain raw native output. **Never ingest it into DAL feedback or send it
to an optimization provider.** The injected sink promises durable acceptance;
synthetic in-memory sinks test await/failure semantics, not durability. Only safe
aggregate statuses/counts/digests belong in a future DAL projection. Unfinished
evidence cannot authorize a completed-trial or efficiency claim.

Live qualification needs version-pinned deployed bindings, verified policy/observation/
sandbox composition, renderer/output budgets, and native subprocess cleanup evidence.
The source adapter implements durable private child records and replay integration.
`assertReady` is a port, not a boolean proof of those guarantees. Native dispatch
must use `ctx.tools.execute` with re-entrant policy checks. Tests deliberately
simulate CAS and policy rejection; they do not implement or verify native CAS.
No current recorder or controller consumes the new private DTO. No artifact is
eligible for live application or promotion merely because these tests pass.

## Verification

```sh
pnpm exec vitest run tests/action-fusion-prototype.test.ts
pnpm run typecheck
```

No shared profile, plugin composition, package dependencies, frozen schemas,
comparison gate or budget policy is modified. The authorized source-component spec
uses an ephemeral unit composition; deployed Loader/profile integration requires a
separately scoped approval. A subsequent live treatment also
requires reviewed opportunity evidence, a valid control, and separate approval.
