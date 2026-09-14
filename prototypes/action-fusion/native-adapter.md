# Default-disabled native checkpoint adapter

Change: `chg-action-fusion-native-checkpoint-20260914`.
Status: **Implemented and source-component tested; deployed runtime unqualified.**

## Concrete native services

`createNativeFusionAdapter(tools, { enabled, timeoutMs, native })` returns an
unregistered adapter. `enabled` defaults to false. `native` supplies the actual
`Session` class and `sessionPersistence` service from the same native composition;
`tools` is its actual `ToolRuntime`. No readiness callback, evidence sink, durable
boolean, or generation-certification parameter is accepted as proof.

The adapter creates no Cordis services, writer handles, archive, plugin entrypoint,
or model-facing registration. AgentLoop owns `bindLiveWriter` and its disposal.
The adapter checks that the native binding API exists but never invokes it.

`bindNativeDispatch` calls `tools.execute` with its receiver intact, fixed native
leaf names (`edit`, `write`, `bash`), distinct validated child IDs, the captured
native agent, parent token, root ID and combined cancellation signal. It binds the
original parent's context/conclusion methods. Native policy runs for each child;
the parent does not implicitly authorize either operation.

## Preflight and durability

For a valid enabled request, before any live-log append:

1. Require the exact parent Session's prototype to match the supplied class and its
   append method to match the class method. Capture its identity for later checks.
2. Require native `bindLiveWriter` and `checkpoint` methods. Missing old APIs fail
   with `blocked / NATIVE_EVIDENCE_UNAVAILABLE`, with no child dispatched.
3. Call the actual `Session.create` with a fresh probe ID. The probe is detached,
   never entered into a store or connected to persistence, notifications or a model.
   Require the same class/method and an empty log. Append a disposable informational
   probe and validate the returned frozen envelope's marker, type, sequence, data
   and sequence advancement. The old append ABI ignores the marker and fails here.
4. Call native `checkpoint(exactParentSession, session.seq - 1, { signal })`.
   Require the returned exact session ID, exact requested sequence, and a nonempty
   writer ID. Retain that writer ID throughout the invocation. A service's mere
   presence or flush-listener participation is insufficient.

Every child start, settlement and skip is appended through native `Session.append`
with the envelope option `{ ignorable: true }`. The adapter validates the actual
returned frozen envelope, then awaits native checkpoint for that exact sequence.
Each acknowledgement must match the exact parent, requested sequence and retained
writer ID. A different writer, including a new writer for the same session, fails.
The adapter never silently upgrades an acknowledgement to a newer prefix.

The native event name is **`dal/action-fusion/child`**. Its payload is the
`Evidence` version-1 interface in `core.ts`: fusion/parent/root/child identities,
operation, start/settle/skipped phase, optional status and bounded native result.
The native envelope owns sequence/time and the ignorable marker. The probe uses
the same event name with a disposable probe payload, never in the live log.
No top-level model tool event, PTC event or known-event catalog entry is borrowed.
Unknown-event replay admission depends on the actual envelope marker.

References have the form `native-session:<encoded-session>:<seq>:<encoded-writer>`.
They identify checkpointed private evidence, not runtime-generation certification.
Writer identity is process-local and is not a persisted generation pin.

## Failures and private results

The adapter admits at most one active invocation per instance. It uses the core's
bounded immutable input/result snapshots and cooperative deadline. Original parent
cancellation reaches native dispatch and checkpoint. Started dispatch is awaited;
there is no racing it against a timeout or detaching it on cancellation.

Native errors/info, content, values, metadata, accepted contexts and spill references
remain in the private result and settlement event within the core's JSON bounds.
Mutation rejection skips the command. Physical effects remain conservatively
possible after dispatch, including a native post-policy rejection. Evidence failure
prevents advancement and yields an incomplete outcome, never rollback or success.
If cancellation rejects a settlement checkpoint, the event may remain queued in the
native writer. A subsequent native flush can persist it but does not retrospectively
make the adapter's acknowledgement or outcome successful. A thrown dispatch or
invalid native result remains `DISPATCH_OR_RESULT_UNCERTAIN` with no fabricated result.

The adapter's `assertReady` implementation proves append/checkpoint capability for
this invocation only. It does not certify the installed policy set, production
filesystem observation/CAS, sandbox or subprocess cleanup. Existing native policy
remains authoritative. There is no live-efficiency or model-uptake claim.

Raw native child evidence stays in the existing private native session. It is not a
DAL feedback schema or a provider-facing projection. Feedback contains safe check
summaries and references only, never child arguments, output, contexts or transcripts.

## ABI and source-integration evidence

DAL retains `@deepseek-ai/dsh-tools@0.1.1-rc.2` development types and unchanged package
and lockfile pins. That installed runtime is **unsupported** for native recording.
`NATIVE_ADAPTER_TARGET` identifies those compile-time tools types, not the patched
ABI or a deployed runtime. `NATIVE_ADAPTER_BLOCKERS` retains the deployed-composition
limitation; it is diagnostic, not a universal execution block for patched source.

The narrow structural interfaces in `native-adapter.ts` describe the patched native
`Session.create`/`append` and `SessionPersistence.bindLiveWriter`/`checkpoint` methods.
Their `never` parameters bridge native branded IDs and merge-extensible event keys
at one documented call boundary. They do not add these methods to old installed
declarations or invent an implementation. The consumer must supply concrete native
services; TypeScript structure is not independent runtime attestation.

The new external DSH spec is
`packages/core/agent-loop/tests/dal-external-integration.spec.ts`. It loads this DAL
module through explicit `DAL_WORKTREE`, with no committed machine path or fallback.
Absent mapping skips with an explicit suite reason; a supplied invalid mapping fails.
The existing DSH **unit** config resolves native source and does not load `.env`.

The spec composes actual Context, SessionStore, SessionProjectionRegistry, AgentLoop,
ToolRuntime and JSONL persistence in an ephemeral unit environment. It registers
deterministic native fixture tools and policies, with real temporary file mutation,
but no production fs/bash providers, subprocess, model adapter or Loader profile.
It proves actual adapter/service compatibility, AgentLoop-owned writer recording,
pre-dispatch durable starts, raw/Zstd flush/reopen/replay, retained native results and
contexts, pre/post-policy rejection, native error info, cancellation and settlement.
It does not qualify a deployed Loader profile or native fs/bash/sandbox composition.

Focused DAL tests cover disabled behavior, actual installed legacy Session rejection
without live-log pollution, synthetic capability/probe/writer failures, exact ack
mismatches and writer changes, append/checkpoint failures, native result preservation,
cancellation, awaited dispatch and concurrent invocation refusal.

Run from the respective designated worktrees (set `DAL_WORKTREE` explicitly):

```sh
# DAL
pnpm exec vitest run tests/action-fusion-native-adapter.test.ts tests/action-fusion-prototype.test.ts
pnpm run typecheck
# DSH, using its credential-free unit configuration
pnpm exec vitest run --config vitest.config.ts packages/core/agent-loop/tests/dal-external-integration.spec.ts
pnpm exec tsc -p tsconfig.host.json --noEmit
```

Deployment/version matching, actual production leaf-policy qualification, reviewed
opportunity evidence, and any live treatment remain separately scoped work. Plugin
mounting, profile/dependency changes and candidate application require their own
approval; these source checks supply none of that authority.

## Source-check receipt — 2026-09-14

| Acceptance | Executed evidence |
| --- | --- |
| AC-C1/C2: disabled and legacy/probe guard | DAL adapter suite, including the actual installed legacy Session: 55 passed |
| AC-C3: exact writer acknowledgements and event failures | DAL adapter fault tests plus native raw/Zstd persistence/reopen |
| AC-C4: native outcomes and awaited cancellation | 62 core tests and the native cancellation/policy cases passed |
| AC-C5: concrete source compatibility | External DSH spec: 6 passed with explicit mapping; 6 explicitly skipped without mapping |
| Type compatibility | DAL `pnpm run typecheck` and DSH `tsc -p tsconfig.host.json --noEmit` passed |

The patched DSH source is preserved in
[`lunarmoon26/deepseek-harness@30684c7469`](https://github.com/lunarmoon26/deepseek-harness/commit/30684c7469ca047898ec2db516257559f6ee8100),
based on `c291e7961a515f6d7af9304e7fd1d257929aef26`. Its
[review PR is in the contributor fork](https://github.com/lunarmoon26/deepseek-harness/pull/1);
upstream PR creation was denied by GitHub permissions. This is not a merged DSH
release or complete runtime-closure digest. The external integration spec is the
only DSH file introduced by the DAL adapter slice. The local-only feedback receipt is
`.dal/store/fb-action-fusion-native-checkpoint-20260914.json`; it records source
fingerprints, focused checks and limitations without native payloads.
