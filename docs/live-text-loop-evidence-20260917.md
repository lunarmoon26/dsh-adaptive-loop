# Native text-loop integration evidence — 2026-09-17

Change: `chg-dal-live-text-loop-20260916`. Status: completed for the bounded,
tool-free text-harness path in `live-text-loop.md`.

This is historical evidence for the pre-HITL, automatic-promotion implementation.
The current contract stages a qualifying candidate for a separate human decision
and adds fixed-policy discovery trees plus offline Dream-RSI-style replay. This
pilot does not evidence those later control paths and must not be retried under its
expired/revoked authority.

## Executed scope

The maintainer separately approved repository-local native dependencies, then the
exact campaign and fixed native-service mount. The pilot uses DSH's native
`openai-codex` route with `gpt-5.6-terra` and the existing native grant store. No API
key, credential-copy adapter, Codex CLI, shared profile, workspace tools or generated
code is involved. Native service instances are created in fresh trusted child hosts
and disposed before replies return. This is not arbitrary-code sandbox evidence.

All tasks are synthetic metric comparisons. The seed deliberately returns one
constant answer. The experiment proves operation of the loop; it is not evidence
that DAL improved the existing CrunchDAO researcher or beats an engineered baseline.

## First attempt and correction

`live-reporting-20260916` stopped before model dispatch with `LIVE_OAUTH_REQUIRED`.
The adapter incorrectly tested a native credential metadata tag as `oauth`; DSH's
credential seam represents opaque OAuth records with kind `grant`. The fix uses
the actual `CredentialRecordEntry` type and has a regression test rejecting absent,
wrong-provider and API-key records. No credential value was inspected to diagnose
this. The failed campaign retains one consumed allocation and its failed receipt;
it was not reset or retried under its old runtime approval.

## Corrected live campaign

- Campaign: `live-reporting-20260917`
- Plan: `e6a41989e1e88b37b5a46117edb0a244f05d5c88555602d995ab20c74406db1f`
- Runtime entry/build pins: `5e149357d12fb1383c62f41a69b25b4489323907e71e3c9ec5121d054f554283`
- Decisions: `dec-live-reporting-20260917`, `dec-live-native-mount-20260917`
- Base generation: `27bd7621b0cb5bcafb51eb0d10c14e8b4c244d6dcb4ae02026aaac4c7295f0bf`
- Generated generation: `56ed6c2621f4ea2dafdacf8b868450dd836d126df8c47a16cd34117410e99690`

| Stage | Observed result |
| --- | --- |
| Baseline development | 0/2 passed |
| Baseline qualification | 0/2 passed |
| Native hypothesis and prompt generation | One valid bounded candidate generated from development-only feedback |
| Candidate development | 2/2 passed |
| Candidate qualification | 2/2 passed; no baseline-passing case regressed |
| Automatic activation | Candidate became the workspace-local current generation |
| Post-activation canary | 1/1 passed through the active pointer |
| Fresh active-generation call | Passed; receipt binds the generated generation |
| Explicit rollback | Prior generation restored |
| Fresh post-rollback call | Returned the prior generation's failing behavior; receipt binds the prior generation |
| Budget guard | Thirteenth request denied before native dispatch |
| Revocation | Further operation denied with `LIVE_GRANT_REVOKED` |

The corrected campaign completed **12 native requests**, with no pending intents.
Reported native usage totals are **1,635 uncached input tokens and 371 output tokens**;
cache counters are zero. These are provider-reported usage counters, not measured
dollar charges. The first failed campaign's usage is unreported and is not silently
folded into those totals. No automatic retry or refund occurred.

The pilot is intentionally left **rolled back and revoked**. The generated prompt
and all immutable evidence remain available. The loop completed and retained the
candidate before the separately requested rollback check. Qualification is an
adaptive selection set; the single canary is a smoke check, not a statistically
powered sealed final evaluation.

## Evidence references

Private campaign artifacts remain below `.dal/live/`:

- `.dal/live/live-reporting-20260916/state-0001.json`: initial failed attempt.
- `.dal/live/live-reporting-20260917/plan.json`: exact frozen inputs and limits.
- `.dal/live/live-reporting-20260917/state-0004.json`: completed automatic promotion.
- `.dal/live/live-reporting-20260917/state-0005.json`: explicit rollback.
- `.dal/live/live-reporting-20260917/operations/`: twelve intent/receipt pairs.
- `.dal/live/live-reporting-20260917/operations/task-active-proof.receipt.json`:
  independent active-generation consumption.
- `.dal/live/live-reporting-20260917/operations/task-rollback-proof.receipt.json`:
  restored-generation consumption.
- `.dal/live/live-reporting-20260917/revoked.json`: terminal revocation marker.

`dal live status --campaign live-reporting-20260917` revalidates the state chain,
generation bytes and task-score receipts without credential access or model calls.
These local artifacts are not automatically published with npm packages or copied
to the team run store. This document intentionally contains summaries and identities,
not prompts, credential material or raw provider responses.

## Automated and packaging verification

- `tests/live-loop.test.ts`: 14 synthetic-transport tests, including automatic
  canary-failure compensation, no-op retention, resume, authority denial,
  concurrency, pending-effect refusal, pointer drift and budget exhaustion.
  A post-pilot hardening also rechecks promotion authority after an in-flight
  canary before final retention; revocation at that boundary restores the incumbent
  in a focused synthetic test. The native pilot's exact runtime identity above
  predates that additive guard; the native adapter bytes are unchanged by it.
- `tests/native-text.test.ts`: 8 tests covering terminal protocol, capability
  rejection, output bounds, usage and native grant metadata.
- Full gate before the final retention-guard hardening: **1,238 passed, 7 opt-in skips**; typecheck, all builds,
  reviewed capsule pins, policy and both offline scorecards passed.
- Final gate after hardening: **1,239 passed, 7 opt-in skips**, with all remaining
  checks passing. The eight-package pack and clean-consumer smoke passed again.
- Native and legacy package graphs are isolated; `pnpm peers check` reports no
  peer issues. This corrected a real old/new LLM export incompatibility.
- Eight 0.2.0 tarballs passed clean-consumer installation, CLI/assets/plugin imports,
  packaged CLI resolution and complete replay. No native model was called by the
  packaging smoke. Registry publication and GitHub OIDC execution remain separate.

Automatic failed-canary rollback is verified with a synthetic transport. The real
canary passed; the native integration separately verifies explicit rollback and
subsequent task behavior. General DSH runtime-closure attestation, arbitrary plugin
evolution, forced OAuth-expiry refresh, and research-productivity gains are not
established by this experiment.
