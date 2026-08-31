# Container-hosted deepseek-harness (DAL-020)

The docker runner executes the same fail-closed dal paths inside a pinned
container so the host's dsh installation, profiles, `~/.dsh/AGENTS.md`, and
`~/.agents` stay untouched. The workspace is bind-mounted at `/workspace`;
`--network none` is hardcoded by the runner; the in-container sandbox seam
(bwrap → Landlock, see `dsh-sandbox-local`) remains the enforcement boundary.

## Build

```sh
pnpm run build   # dist/ must exist before the image build
docker build -f deploy/docker/Dockerfile -t dsh-adaptive-loop/dsh:0.1.1-rc.2 .
```

The image pins `@deepseek-ai/dsh@0.1.1-rc.2` and `pnpm@11.7.0` on
`node:24-slim`, installs `bubblewrap`, and carries the dal runtime
(`/opt/dal/dist`, `/opt/dal/schemas`, `/opt/dal/config`) with linux-built
node_modules. Supply-chain rule: before sharing the image, pin the base image
digest and record the image's own digest in the deployment evidence.

Demo image (2026-08-31, bakes the benchmark workflow-tools plugin with the
strategy-neutral tool descriptions and `resolutions` config):
`dsh-adaptive-loop/dsh:0.1.1-rc.2-demo`, image id
`sha256:2fca609a5f11bbc732167c419a378c9fa92be43fb755d1ca4a13606df28fa933`
(sandbox probe re-run after the rebuild: `landlock-run`, enforcement full).
The e2e driver's approval manifest and receipts digest the workflow-tools
bytes *inside* this image, so rebuilding the image invalidates every prior
batch decision.

Probe-verified base image (2026-08-29, this workspace):
`sha256:9e3cb523c1f90a44e49dcb49e60f84764cf4b5c113c210e0e97534dfa63b35ea`.

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
  --action benchmarks/tau-style-workflow/dal/fixtures/verifier-write.json \
  --command "sh -c 'echo x > /tmp/outside.txt'"
```

Expected: rejected in the backend's own denial dialect (exit non-zero).

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

`pnpm benchmark:e2e` runs approval-bound pass@k batches against the demo
image directly (not through the dal policy runner), so it manages its own
container contract:

- it passes exactly the selected provider's credential env (`.env.example`
  lists all five) and fails closed before any call when the key is missing;
- each attempt gets a batch-local `DSH_HOME` bind mount, and the receipt
  records the real `dsh_session_id` + session event-log head digest plus the
  business effect-log digest (`business_effect_log_head_sha256`);
- `--attempts N`, `--compare <summary>`, `--generation`, `--faults`, and
  `--resolutions` shape the run; see
  [`benchmarks/tau-style-workflow/PROVIDERS.md`](../../benchmarks/tau-style-workflow/PROVIDERS.md)
  for the multi-provider matrix and the transmission-manifest decision flow;
- on a docker transport failure it kills lingering containers, reseeds the
  per-batch service state, relaunches Docker Desktop when the daemon is
  down, and retries the attempt once.
