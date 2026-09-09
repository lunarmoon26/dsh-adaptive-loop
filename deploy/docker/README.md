# Container-hosted deepseek-harness (DAL-020)

The verifier's Docker runner executes the same fail-closed dal paths inside a pinned
container so the host's dsh installation, profiles, `~/.dsh/AGENTS.md`, and
`~/.agents` stay untouched. The workspace is bind-mounted at `/workspace`;
`--network none` is hardcoded by the runner; the in-container sandbox seam
(bwrap → Landlock, see `dsh-sandbox-local`) remains the enforcement boundary.

## Build

```sh
pnpm run build   # dist/ must exist before the image build
docker build -f deploy/docker/Dockerfile \
  -t dsh-adaptive-loop/dsh:0.1.1-rc.2 \
  -t dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2 .
```

The image pins `@deepseek-ai/dsh@0.1.1-rc.2` and `pnpm@11.7.0` on
`node:24-slim`, installs `bubblewrap`, and carries the dal runtime
(`/opt/dal/dist`, `/opt/dal/schemas`, `/opt/dal/config`) with linux-built
node_modules. Supply-chain rule: before sharing the image, pin the base image
digest and record the image's own digest in the deployment evidence.

The benchmark-v2 tag bakes the typed workflow client/service and the remote
grader entry point. The e2e approval manifest and receipts digest the image
and workflow-tools bytes *inside* it, so rebuilding the image invalidates
every prior batch decision. Record the new digest and rerun the sandbox and
topology probes after each rebuild. Current local build (2026-09-01):
`dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2`, image id
`sha256:1adcf95dedf922eaf182fefee0d4ddcaf90fed00eaa2eb947bfe99f7f97f64d9`.
The service/grader topology probe and Linux sandbox probes passed for this
image; the verifier reported `landlock-run` with full enforcement, and the
out-of-workspace write probe was denied by the backend. The in-image
workflow-tools tree digest is
`7e6ea2a4a1ce8f9a688472e8209da11fd1e347b10e62e3357c00fbc46b212905`.
The local plugin installation in this build was authorized by
`dec-dal-workflow-tools-image-20260901` for the exact source digest and
isolated-image scope; it did not install or mount a host profile.

Resolved `node:24-slim` parent manifest for this local build:
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`.
The Dockerfile tag remains mutable; pin that digest before sharing the image.

## Sandbox probe (run after every image rebuild)

The container's Linux sandbox chain needs unprivileged user namespaces plus
the seccomp permissions Docker blocks by default — the policy default passes
`--security-opt seccomp=unconfined` (see `config/policy.v1.json`
`docker_run_flags`). Prove the chain before trusting it:

```sh
pnpm dal verify run --runner docker \
  --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json \
  --command "node /opt/dal/node_modules/tsx/dist/cli.mjs /workspace/benchmarks/tau-style-workflow/grader/grade.ts /workspace/benchmarks/tau-style-workflow/tasks/task-001-refund.json /workspace/benchmarks/tau-style-workflow/dal/fixtures/result-pass.json"
```

Expected: `passed: true` and `sandbox.backend` in `bwrap` or `landlock-run`.
A failing chain reports `SANDBOX_UNAVAILABLE` — it never falls through
unconfined.

Denial probe:

```sh
pnpm dal verify run --runner docker \
  --action benchmarks/tau-style-workflow/dal/fixtures/verifier-grader.json \
  --command "sh -c 'echo x > /root/dal-exec-denied.txt'"
```

Expected: exit non-zero with the backend's own permission-denied dialect.

Note: in-container commands must reference the image's own node_modules —
`/opt/dal/node_modules/.bin/tsx` — because `/workspace/node_modules` is the
host's platform build. Paths under the workspace are auto-translated to
`/workspace/...`.

## Payload-only proposer (no Docker)

The proposer does not run dsh or mount a workspace. It sends one fixed-route
OpenAI, Anthropic, or DeepSeek HTTPS request after exact v2 request-digest approval
and durable budget reservation. Docker proposer
execution and Docker policy flags are rejected with `PROPOSE_RUNNER_UNSUPPORTED`.
Prepare locally with an explicit model and reviewed budget allocation file (see
the focused contract for its three required fields); preparation makes no external call:

```sh
pnpm dal propose prepare --clusters .dal/clusters \
  --provider openai --model gpt-5.6-terra --budget budget.json --output request.json
```

Review the versioned request and obtain an approved, unexpired
`send_data_externally` decision whose scope is the printed `request_digest`, not
`payload_digest`. Only after that separate authorization, run with the same inputs:

```sh
pnpm dal propose run --clusters .dal/clusters \
  --provider openai --model gpt-5.6-terra --budget budget.json \
  --approval decision.json --output draft.json
```

Use `--provider anthropic --model claude-sonnet-5` for Anthropic, or the explicit
DeepSeek route/model. Only the selected `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`DEEPSEEK_API_KEY` in the sending process environment supplies credentials;
the proposer never loads `.env`, profiles, tools, or workspace artifacts. The key
is read at send time and never persisted. Legacy `--runner local` uses the same
payload-only HTTPS transport, and legacy `--workspace` is ignored. Request details
and limits are owned by [`docs/proposer-request.md`](../../docs/proposer-request.md).
These commands are documentation, not authorization for a live model call.

## E2E batch driver (tau-style workflow)

The metered runner requires explicit mode, campaign, provider/model, provider cap,
and an image with verified build provenance. Build the local derived image without
using the repository as Docker context:

```sh
pnpm exec tsx benchmarks/tau-style-workflow/build-gateway-image.ts
```

The builder compiles first, compares source inventories before/after, copies only
generated JavaScript and schemas into a private minimal context, and verifies
in-image artifact hashes. The existing local benchmark-v2 image is the base; no
provider credentials enter the build. It manages the following execution contract:

- only the live model gateway receives the selected provider credential and an
  outbound network; the candidate receives an ephemeral gateway capability on an
  internal network with no provider key or ledger mount;
- each attempt stages only the agent-visible task, policy, candidate skill,
  and exact composition patch into a read-only candidate workspace; the
  repository, goal state, grader source, journal, and receipts are not mounted;
- a separate service container owns the writable checksummed effect journal
  and exposes only typed workflow endpoints to the candidate; a grader-only
  internal network exposes an authenticated evaluator snapshot to a third
  container that mounts only the full task;
- each attempt gets its own writable `DSH_HOME`; the receipt records the real
  dsh session/event-log head, journal digest, staged-workspace digest, image
  digest, and explicit `candidate-service-grader-v1` isolation facts;
- `--attempts N`, `--compare <summary>`, `--generation`, `--faults`, and
  `--resolutions` shape the run; see
  [`benchmarks/tau-style-workflow/PROVIDERS.md`](../../benchmarks/tau-style-workflow/PROVIDERS.md)
  for the multi-provider matrix and the transmission-manifest decision flow;
- there is no candidate retry after transport failure; final cleanup removes only
  owned resources and preserves the shared campaign ledger;
- `--runner local` is rejected because it cannot prove oracle isolation.

The approval manifest binds rollout count, projected and full task digests,
driver source, and the immutable image identity. After verification it is
stored under `.dal/check/e2e-manifests/`, rehashed before each model call, and
bound into every receipt; service, candidate, and grader containers launch by
its image digest, not by the mutable tag. Summaries carry candidate, generation,
manifest, persisted run-record, and frozen benchmark-context digests so the
compare gate can reject reused evidence, inconsistent counters, benchmark
drift, hand-authored attribution, and model+harness confounding.
Only `g0` and `g1` labels are accepted while G2 remains unmounted source.

For the native keyless DSH rehearsal and finite pending-approval live preparation,
use [the preflight guide](../../docs/paid-campaign-preflight.md). Rehearsal has no
gateway egress or keys, reports protocol and business outcomes separately, and
stores its evidence outside `.dal/runs`. Both modes inspect isolation before and
after execution. The same ledger and conservative reservation policy apply to
[metered proposals](../../docs/metered-proposal.md); direct proposals are not the
campaign handoff.

The narrower no-model topology probe remains available after rebuilding:

```sh
CI=true DAL_E2E_TOPOLOGY_PROBE=1 pnpm exec vitest run tests/e2e-topology.test.ts
```

It starts the service on two isolated networks, performs typed effects from a
candidate-network container, and grades the authenticated snapshot from a
grader-network container. It does not invoke a model or exercise the full dsh
candidate loop.
