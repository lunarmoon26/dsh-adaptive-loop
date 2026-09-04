# dsh plugin contract (proposer knowledge)

Condensed, pinned facts a proposer needs before proposing changes to skills or
plugin sources for DeepSeek Harness (inspected identity: `@deepseek-ai/dsh@0.1.1-rc.2`
plus its bundled Cordis packages). Full citations live in `docs/research-evidence.md`.

## Plugins are packages in a patch-composed tree

- A plugin is an npm package loaded by the Cordis tree. It exports either a
  Cordis plugin (a Service with `static inject` and a `Config` schema) or a
  tool package exporting `name`, `inject`, and `apply(ctx, config)`.
- A **bundle** is a package whose manifest declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The patch file is a
  list with one `- insert:` block of entry rows
  `{ id, name: '<package>', config?: {...}, disabled?: true }`.
- Composition order (last write wins per row): bundle patches (in
  `dsh.profile.bundles` order) → the profile's own `cordis.patch.yml` → the
  home-level user patch layer (`$DSH_HOME/cordis.patch.yml`) → `--patch`
  overlays → flag-derived rows (e.g. telemetry switch).
- Bundle/entry names resolve from the dsh installation anchor first, then the
  profile directory (`node_modules` the profile's pnpm manages). A later
  layer can restate a row (including flipping `disabled`).

## Tools

- Tools register on `ctx.tools.register(defineTool({ name, description,
  parameters, output: { schema, render }, execute(args, exec), ... }))`.
- `parameters` and `output.schema` use dsh's JSON-schema vocabulary:
  `required: true` (no `required: false`), `type: "json"` for arbitrary
  payloads, `oneOf` for unions, `additionalProperties: false` on objects.
- Tool output is the canonical lossless-JSON value; `render` produces
  model-facing content. Tools must settle with `exec.signal`; schema changes
  are model-visible — registry and schema travel together.

## Sessions and recording

- The session is an append-only event log (`ctx.sessions`); persistence
  plugins subscribe to `session/event` (fire-and-forget), drain durably on
  awaited `session/flush`, and may attempt a final drain on observe-only
  `session/disposed`. Disposal listener promises are contained but not awaited,
  so they cannot prove final persistence before process teardown.
- Runtime- and candidate-generation binding is synchronous at
  `session/created`, before the first event. The optional launcher-owned
  `runtimeGeneration` service returns a precomputed binding plus a monotonic
  transition sequence; the optional `dalCandidate` service reports the admitted
  HMR generation. The recorder does not infer identity from later events or
  late-bind either source, and candidate checkpoints are evaluation-ineligible.
- Event vocabulary includes `turn/start|end`, `step/start|end`,
  `assistant/message` (+`usage`), `tool/call` (name + raw arguments),
  `tool/result` (error name/code), `request/header` (config incl. provider/
  model + system text), `request/context` (route metadata).
- Model-visible means logged: the durable event log is the canonical history;
  projections must record digests/counts, never raw arguments or results.
- Current DSH does not expose enough authoritative resolver/config/mutation
  state for DAL to produce verified runtime manifests. The required launcher
  and Loader producer contract is documented in
  `docs/runtime-generation-attestation.md`; until it exists, recorder output
  remains unattested and controller-ineligible.

## HMR candidate admission

- `hmr/reload` carries `Map<oldPlugin, { filename, runtime? }>` and is emitted
  only after every selected plugin replacement succeeds. Import or activation
  failure restores the prior module cache/runtime and emits no success event.
- Candidate admission matches the configured entry's canonical file URL, not a
  plugin display name. Every successful HMR event advances the observed sequence;
  therefore an unrelated reload still invalidates an in-flight evaluation run.
- Multi-file candidates publish imported dependencies first and the loaded entry
  last. Candidate bytes stay in a fixed inactive staging directory until an exact
  `apply_optimization_candidate` decision verifies at the copy operation.
- Approval verification runs through one bounded chain of absolute launcher files
  outside the candidate worktree. Their startup digests must still match at the
  operation; workspace package scripts never select the verifier.
- Any successful reload that omits the configured entry or activates different
  bytes aborts pending admission and triggers baseline restoration.
- HMR activation is evaluation admission, not promotion. Only a later human git
  review and commit promotes the workspace source.
- `candidate_generation` is a recorder observation. Standalone run ingestion
  checks shape and consistency but neither authenticates HMR admission nor grants
  application or promotion authority.

## What a proposal may and may not touch

- Editable surfaces: prompt, tool descriptions, skills, memory policy,
  routing, stop/retry logic, harness code (plugin sources, patches).
- Immutable anchors: evaluator, sealed holdout, permissions, maximum budget,
  promotion policy, audit log, rollback mechanism. Proposals targeting these
  are invalid at every stage.
- Mounting/installing a plugin into a real profile is an approval-gated
  `install_or_mount_plugin` operation; proposals describe workspace-VCS-owned
  sources and their patch rows, never a direct profile mutation.
