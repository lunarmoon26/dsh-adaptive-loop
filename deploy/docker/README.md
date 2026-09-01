# Container-hosted deepseek-harness (DAL-020)

The docker runner executes the same fail-closed dal paths inside a pinned
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
topology probes after each rebuild. Current local build (2026-08-31):
`dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2`, image id
`sha256:df7173dfcf8edbd1c68623286a2451900b3f7e50f31f4ac33d2c737f28bf0ef3`.
The service/grader topology probe and Linux sandbox probes passed for this
image; the verifier reported `landlock-run` with full enforcement, and the
out-of-workspace write probe was denied by the backend.

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

## Headless propose in the container

```sh
pnpm dal propose run --runner docker \
  --clusters .dal/clusters --approval <decision> --workspace <dir> --output <draft>
```

Model credentials pass through only the `docker_env_names` listed in the
policy (default `DEEPSEEK_API_KEY`). Provide them on the host either in the
process environment or in a workspace-root `.env` file (copy
[`.env.example`](../../.env.example) to `.env`; `.env` is gitignored) —
never in VCS or the image. The host environment wins over `.env`.

## E2E batch driver (tau-style workflow)

`pnpm benchmark:e2e` runs approval-bound pass@k batches against the
benchmark-v2 image directly (not through the dal policy runner), so it
manages its own container contract:

- it passes exactly the selected provider's credential env (`.env.example`
  lists all five) and fails closed before any call when the key is missing;
- the candidate network allows provider egress and is not destination-
  allowlisted; use a dedicated short-lived key and do not treat oracle
  isolation as credential-egress confinement;
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
- on a docker transport failure it removes the attempt's named containers,
  atomically reseeds the journal, relaunches Docker Desktop when the daemon is
  down, and retries the candidate once; final cleanup removes both networks;
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

Run the no-model topology probe after rebuilding:

```sh
CI=true DAL_E2E_TOPOLOGY_PROBE=1 pnpm exec vitest run tests/e2e-topology.test.ts
```

It starts the service on two isolated networks, performs typed effects from a
candidate-network container, and grades the authenticated snapshot from a
grader-network container. It does not invoke a model or exercise the full dsh
candidate loop.
