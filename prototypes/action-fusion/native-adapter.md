# Inactive native adapter: dispatch binding and durability blockers

Change: `chg-action-fusion-native-adapter-20260914`.
Status: **Dispatch binding implemented; end-to-end native adapter blocked.**
No plugin registration, service construction, profile mutation, package upgrade,
native-session creation, model call or research attempt is part of this slice.

## Implemented surface

`native-adapter.ts` imports native types from DAL's existing exact development
dependency `@deepseek-ai/dsh-tools@0.1.1-rc.2`. It does not import personal source
paths, resolve a home profile, or claim the currently deployed DSH ABI is this
release. The reference checkout is
`deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26`.

`bindNativeDispatch(tools, parent)` binds an actual `ToolRuntime` object and native
`ToolRunContext`. It preserves the typed native agent, parent token and root ID,
brands only validated UUID-based child IDs, and calls `tools.execute(...)` with
its receiver intact. It rejects child identity substitution and non-leaf targets.
Parent cancellation is fused with child cancellation. Native canonical results,
error messages/info, spill metadata and contexts are not reduced or fabricated;
the existing core owns bounded lossless snapshots and failure classification.
Context/conclusion methods remain bound to their original native parent receiver.

This low-level binding is not a fused tool, readiness proof or deployment API. A
caller already possessing the native runtime can dispatch native tools; the
binding does not replace that runtime's own authorization. It is not exposed to a
model. Its exported function allows direct unit verification with typed doubles.

`createNativeFusionAdapter(tools, options)` is the guarded entrypoint. Default
behavior is `disabled`. Explicit `enabled: true` still returns
`blocked / NATIVE_EVIDENCE_UNAVAILABLE` for valid inputs, before dispatch or
evidence side effects. Invalid input and prior cancellation retain the core's
outcomes. Missing native agent identity is an explicit binding error. No injected
readiness callback, sink or configuration flag enables a live fused operation.
The factory exposes diagnostic blocker codes; these are limitations, not runtime
attestation records. A future qualifying implementation needs a separately reviewed
code change, not a boolean claiming that evidence is durable.

## Why durable native recording is blocked

Read-only inspection identified two concrete obstacles in both the installed
release and the newer reference implementation:

1. **Unknown-event persistence compatibility.** The session envelope has an
   `ignorable` field, but the public `Session.append` signature and implementation
   have no option that sets it. Current-source anchors:
   `packages/core/session/src/index.ts:710–738` and
   `packages/core/session/src/types.ts:483`. Unknown unmarked persisted event
   types are rejected by
   `packages/session/session-persistence/src/storage-contract.ts:55–103`.
   Casting an extra append argument, putting the marker in payload data, mutating
   the frozen event, borrowing PTC/code-specific event types, or changing the
   known-event catalog does not supply a supported extension path.
2. **Flush is not a per-session durable-writer receipt.**
   `SessionStore.flush(session)` reports listener participation and awaits those
   listeners (`packages/core/session/src/index.ts:1131–1169`). The JSONL listener
   can return without a writer for the session
   (`packages/session/session-persistence-jsonl/src/storage.ts:534–547`). Therefore
   `true` does not establish durable acceptance for that exact session. Acquiring
   a second write handle would conflict with the live single-writer owner; the
   adapter must not append around it.

The native dispatcher itself is usable: its public execute pipeline rechecks
policy for children. But dispatch notifications are not durable child event
appends. Neither successful tool output nor a mounted service's presence fills
the recording gap. This slice deliberately adds no second archive or persistence
route to evade the owning session writer and replay rules.

## Version and verification boundaries

| Source | Relevant API |
| --- | --- |
| Installed `dsh-tools` `0.1.1-rc.2` | `CallId`, code-dispatch vocabulary; peer session format 0 |
| Reference source `0.1.5-rc.2` | `ToolCallId`, PTC-dispatch vocabulary; session format 3 |

Those are not interchangeable version claims. Existing package/lockfile pins are
unchanged. Type checking and an import-only check verify installed exports and
the compiled adapter surface. Service-double tests verify argument routing,
receivers, cancellation and no-dispatch blockers. They do not construct Cordis
services or mount native plugins, and do not establish native policy enforcement,
filesystem CAS, sandbox containment, persistence, replay, cleanup or efficiency.

Focused checks:

```sh
pnpm exec vitest run tests/action-fusion-native-adapter.test.ts tests/action-fusion-prototype.test.ts
pnpm run typecheck
```

## Required next scope

Qualify an approved deployed DSH version, a supported extension-event envelope,
and the exact live-session writer/checkpoint route before replacing the readiness
block. Such work may require an upstream DSH package change under that repository's
own instructions; this task does not authorize that change or live activation.
Then separately approve native keyless integration and its profile/plugin bytes.
Only after that, and after reviewed opportunity evidence and a valid fixed lean
control, consider the separately authorized live harness-treatment comparison.
