# DAL Codex OAuth terminal bootstrap

An opt-in terminal surface for DSH's native `openai-codex` OAuth flow. Requires
DSH launcher services and the native authorization/credential/provider services
(inspected DSH 0.1.5-rc.1 with 0.1.5-rc.2 packages). No Agent or model is invoked.

After exact approvals for installation, the invocation overlay and external OAuth:

Use a headless-derived profile whose manifest sets `dsh.profile.patchReload` to
`startup`. The overlay disables module HMR, but cannot change that manifest-level
setting; a live patch watcher must not alter the auth composition mid-flow.

For login, set `DAL_WORKTREE` to the reviewed DAL checkout, and set
`DAL_CODEX_OAUTH_APPROVAL` and `DAL_CODEX_OAUTH_MANIFEST` to the operator-prepared
decision and package/transmission manifest files. These are paths, not credentials.
The manifest names this plugin, the native credential key/method and the exact
package/runtime file hashes. Login rechecks those bytes and invokes only the fixed
local `pnpm dal approval verify` command with action `send_data_externally` and
scope `codex-oauth-bootstrap-login:<manifest SHA-256>`. Missing/expired/drifted
approval prevents `authorization.begin`. `--oauth-check` does not require a grant
or login approval because it performs no authorization attempt.

```sh
# Build in the supervisor-designated worktree of lunarmoon26/dsh-adaptive-loop.
pnpm exec tsc -p plugins/dal-codex-oauth/tsconfig.json
dsh plugin --profile crunch-codex-research add ./plugins/dal-codex-oauth

# Public flow metadata only: no login or credential inspection.
dsh --profile crunch-codex-research --patch ./plugins/dal-codex-oauth/bootstrap.patch.yml --oauth-check

# Run in your own terminal, not an agent tool or redirected shell.
dsh --profile crunch-codex-research --patch ./plugins/dal-codex-oauth/bootstrap.patch.yml --oauth-login
```

Open the displayed OpenAI URL in your browser. If the native flow asks for a manual
response, paste it into this terminal; all input is hidden, including text/callback
URLs. Browser completion may withdraw that prompt automatically. Never paste it
into agent chat. DSH's authorization service confirms grant persistence; this plugin
never receives the grant or opens credential files. It does not reuse Codex CLI auth.

`--oauth-check` success means only that the native OAuth method is registered, not
that you are signed in. Login exits 0 only after native authorization confirms a
committed grant; cancellation exits 130, timeout 124, noninteractive/usage errors 2,
and other failures 1. Provider exception details are not printed.

Resume research **without** the auth-only overlay. HMR remains disabled, and this
package exposes no model, arbitrary subprocess, HTTP endpoint or credential-export API.
Its only subprocess is the fixed, bounded local DAL approval verifier; its output
is captured and never relayed into OAuth interaction logs.
The package deliberately has no `dsh.bundle`; installing it cannot silently replace
research with login mode. See the [contract](../../docs/codex-oauth-bootstrap.md).
