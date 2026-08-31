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
  plugins subscribe to `session/event` (fire-and-forget) and drain on
  `session/flush` and `session/disposed`. Observer failures are contained and
  never fail an append.
- Event vocabulary includes `turn/start|end`, `step/start|end`,
  `assistant/message` (+`usage`), `tool/call` (name + raw arguments),
  `tool/result` (error name/code), `request/header` (config incl. provider/
  model + system text), `request/context` (route metadata).
- Model-visible means logged: the durable event log is the canonical history;
  projections must record digests/counts, never raw arguments or results.

## What a proposal may and may not touch

- Editable surfaces: prompt, tool descriptions, skills, memory policy,
  routing, stop/retry logic, harness code (plugin sources, patches).
- Immutable anchors: evaluator, sealed holdout, permissions, maximum budget,
  promotion policy, audit log, rollback mechanism. Proposals targeting these
  are invalid at every stage.
- Mounting/installing a plugin into a real profile is an approval-gated
  `install_or_mount_plugin` operation; proposals describe workspace-VCS-owned
  sources and their patch rows, never a direct profile mutation.
