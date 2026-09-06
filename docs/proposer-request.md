# Payload-Only Proposer Request

Status: Accepted
Change: `chg-dal-proposer-receipt-boundary-20260906`
Scope: DAL-015 proposer confinement; DAL-020 excludes proposer Docker execution.
Exact machine owner: [`../schemas/proposer-request.v1.schema.json`](../schemas/proposer-request.v1.schema.json).

## Contract

The proposer sends only reviewed, sanitized cluster projections and fixed instructions.
It never loads workspace artifacts, profiles, plugins, tools, shell commands, or `.env`.
Preparation takes proposal data only from explicitly supplied cluster/run stores;
it also reads bundled local schemas for validation. Repository pointers are
opaque references, not permission or instructions to retrieve their contents. Artifact
base digests in replies are unverified model assertions requiring human verification.

`prepareProposeRequest({ clustersDir, runsDir?, model: { provider, model } })`
returns the existing `payload`, `digest` (payload provenance), and `json`, plus
`request`, `requestDigest`, and `requestJson`. Provider is exactly `deepseek-official`;
the model is explicit. The fixed endpoint is
`https://api.deepseek.com/chat/completions`. The canonical request envelope binds
endpoint, provider, HTTP method, content type, credential environment-key designation,
the complete body (including all instructions), and request/response/time limits.
The envelope includes `$schema` and `schema_version: 1.0.0`, both included in its
canonical digest. Preparation validates the closed request schema through the local
catalog before returning or persisting it. Alternate routes, extra tools or fields,
and unsupported versions fail validation. Adding these version fields invalidates
earlier unversioned request approvals; prepare again and obtain a new exact approval.
Credentials themselves are excluded and read only from `DEEPSEEK_API_KEY` at send time.
The designated credential must be nonempty printable ASCII, at most 512 characters.

`runPropose` rebuilds that envelope and verifies an approved, currently effective,
unexpired `send_data_externally` decision against `requestDigest` before transport or
credential access. Old payload-only approvals fail. There is one POST, no retries,
`redirect: error`, no tools, and no streaming API response. Request bytes are capped
at 64 KiB, response bytes at 128 KiB, timeout at 30 seconds through the full body,
and output at 2048 tokens. Transport errors reveal no response, prompt, or credential.
Tool/function calls, incomplete replies, invalid JSON, and sensitive drafts fail closed.

Legacy `runner: local` uses only this transport; `workspaceDir` is ignored.
`runner: docker` or any Docker configuration fails with an actionable error. The
internal `runnerOverride` seam is for offline tests only and is never CLI-exposed.
Drafts retain `payload_sha256` and additionally bind `provenance.request_sha256`;
production runner identity is `deepseek-https`. Historical draft records remain
schema-readable without the additive request digest; new proposer records carry it.

## Acceptance Criteria

1. Endpoint/model/instruction drift changes request identity and invalidates approval.
2. Missing, wrong-scope, expired, or old payload approvals cause no transport or credential access.
3. Neither transport nor model has workspace/profile/subprocess/tool capabilities.
4. Bounded requests, responses and full-body timeout fail without retries or sensitive diagnostics.
5. Tool-call, invalid, secret-bearing and PII-bearing replies persist nothing.
6. Offline mock tests prove the boundary; no live provider or sandbox proof is claimed.
7. Persisted requests validate against the versioned closed schema; route, tools,
   metadata, limits and version drift fail validation without granting send authority.

## CLI Contract

CLI prepare calls `prepareProposeRequest`, requires `--model`, defaults provider to
`deepseek-official`, writes `request` rather than payload, and prints `request_digest`
alongside `payload_digest`; approval scope is `request_digest`. Run requires the same
explicit model, no longer requires workspace, reports both digests, and rejects Docker
without loading policy. Endpoint, key name, fetch, prompt, and runner override are not
CLI options. The prepared file is a request envelope, not a draft or send authorization.

```sh
pnpm dal propose prepare --clusters .dal/clusters --model deepseek-v4-flash --output request.json
```

Review that file and obtain a separate approved, unexpired `send_data_externally`
decision scoped to the printed `request_digest`. With the same stores, provider and
model, the separately authorized command is:

```sh
pnpm dal propose run --clusters .dal/clusters --model deepseek-v4-flash --approval decision.json --output draft.json
```

Neither command needs Docker or a workspace argument. These examples do not authorize
a live call. The schema validates envelope structure and fixed options; code enforces
the aggregate UTF-8 byte cap, canonical payload encoding, privacy scanning, and exact
operation-time approval. Schema validation alone grants no authority to send.

## Verification Handoff

The initial unintegrated schema/CLI failures are superseded by main's integrated
verification. Focused offline tests cover versioned schema acceptance, closed route,
metadata, limits and tool rejection, digest drift, approval, privacy, timeout and size
limits. No schema bypass or live provider proof is used. Full repository check,
shared documentation synchronization and feedback publication remain main-owned.

Producer verification on 2026-09-06: `propose-transport`, `propose`, `cli`, `branch`
and `execution-receipt` focused suites pass 110/110 tests (40, 19, 8, 5 and 38
respectively). Root `tsc -p tsconfig.json --noEmit` and `git diff --check` pass.
No network, model call, Docker run, install, full repository check, feedback write,
commit or push is performed for this follow-up.
