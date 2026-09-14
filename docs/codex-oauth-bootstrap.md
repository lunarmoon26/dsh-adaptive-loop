# Codex subscription OAuth bootstrap

Change: `chg-codex-oauth-bootstrap-20260913`. Status: implemented and keylessly
verified; successful interactive authorization was subsequently reported by the
operator. Browser sign-in is not an automated test.

## Accepted scope

The installed DSH provider adapter supports Codex OAuth, but its current web Models
editor accepts API keys only and the shipped web/headless bundles do not mount an
authorization interaction surface. `@lunarmoon26/dal-codex-oauth` supplies a small
terminal surface through an explicitly selected DSH profile overlay. It is not a
new OAuth implementation, an LLM client, an optimizer, or an automatic installer.

The plugin calls only the native authorization flow for
`llm-pi-ai/openai-codex`, explicitly selecting `oauth`. DSH/pi-ai owns PKCE,
browser callback handling, token exchange, refresh and credential persistence.
The plugin never reads/copies credential files or receives a returned grant.
It never creates an Agent, calls a model, or substitutes Codex CLI/API-key auth.

## Acceptance criteria

- Native fixed-key OAuth only; missing flows and API-key-only methods fail closed.
- `--oauth-check` verifies flow registration without beginning login or reading a
  grant. No LLM/session is created by the bootstrap.
- `--oauth-login` requires interactive stdin and stdout. All entered responses,
  including nominally text callback URLs/codes, are hidden and never logged.
  Provider errors are reduced to fixed status messages; credential values never
  enter stdout, stderr or DAL evidence.
- Before login, the plugin rehashes its exact declared package/runtime inventory
  and invokes the real, bounded local DAL approval verifier for the exact manifest
  digest. Missing, mismatched or expired approval blocks `authorization.begin`.
  This disk-drift check is not authoritative runtime-generation attestation.
- Timeout, EOF, prompt withdrawal and disposal cancel/clean up correctly. A
  browser callback cancelling its losing text prompt does not cancel the login.
  Exit goes through DSH's launcher service, not `process.exit` or signal handlers.
- Keyless tests cover those contracts; a real DSH `--oauth-check` verifies the
  installed composition. Actual browser sign-in is reported separately, not inferred
  from a fake flow or a successful check.

## Approval and operating boundary

Installing/mounting this plugin and DSH's native authorization row, and changing the
selected profile composition, require exact unexpired approvals. Beginning login
also requires an approved external OAuth operation. It does not authorize model
requests, dataset transfer, HMR, optimizer application or other profile changes.
The auth-only overlay disables the headless task runner/startup, agent loop,
auxiliary title model, telemetry and module HMR. The reviewed profile must also
set `dsh.profile.patchReload` to `startup` in its manifest: disabling the HMR row
alone does not disable DSH's live patch watcher. Research resumes without this overlay.
The package is not a `dsh.bundle`: installing it alone cannot activate login mode.

Only an operator's terminal displays the browser authorization URL/device challenge.
Do not pipe/redirect an interactive login or paste its response into agent chat.
There is no general-purpose HTTP server or credential-export endpoint in this
plugin. Native provider callback handling is delegated, not replaced.

Canonical DSH contracts: `packages/credentials/authorization/src/index.ts` and
`types.ts`, `packages/llm/llm-pi-ai/src/login.ts`, and
`packages/boot/cmdline/src/index.ts` in `deepseek-ai/deepseek-harness`.

## Observed verification

The dedicated profile already used startup-only patch loading. After scoped
approval verification, the plugin was installed as a plain dependency and an actual
DSH `--oauth-check` returned `DAL_CODEX_OAUTH_READY`. This proves composition and
native-flow registration, not a stored grant or successful subscription request.
Keyless unit tests cover the interaction, approval verifier, timeout and disposal
paths without accessing real credentials or contacting an OAuth provider.

The operator subsequently reported `DAL_CODEX_OAUTH_AUTHORIZED`, and the research
workflow then made authenticated DSH/Codex calls. Those observations support the
integration status; they do not certify OAuth internals, expose grant contents or
establish researcher improvement. The first research attempt was separately blocked
by a workspace-sandbox cache-write restriction, not by subscription authentication.
