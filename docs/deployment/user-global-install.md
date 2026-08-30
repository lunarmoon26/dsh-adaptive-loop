# Tier-2 user-global install scope

Status: Executed, then removed on the operator's host (2026-08-29, decision `dec-user-global-remove-20260829`): host dsh sessions stay clean because testing runs through the docker-hosted harness (`deploy/docker/`), which mounts the workspace's own `AGENTS.md` and skills and needs no global install. The install command remains available for machines without the container path. Each (re)install requires a fresh, exact, unexpired human approval.

This document defines the exact scope of the user-global dal deployment. The decision scope digest binds the exact template bytes of `docs/deployment/end-task-feedback-global-SKILL.md` and `docs/deployment/user-global-AGENTS.md` (computed by `dal install user-global`), so editing either template or retargeting any install path voids prior decisions and requires a new approval.

## What the install does

1. **Skill** — copy `docs/deployment/end-task-feedback-global-SKILL.md` to `~/.agents/skills/end-task-feedback/SKILL.md` (user-agents skill root; discovered by dsh in every workspace at `packages/skill/skill-filesystem/src/index.ts:252-259`).
2. **Global instructions** — copy `docs/deployment/user-global-AGENTS.md` to `~/.dsh/AGENTS.md` (the fixed user-global AGENTS.md candidate at `packages/context/agent-instructions/src/config.ts:19`).
3. **CLI** — `npm install -g .` from this repository, which registers the `dal` bin in the nvm-managed global prefix (`~/.nvm/versions/node/v24.19.0/bin`, already on PATH).

## What the install does not do

- No dsh profile, plugin, or `$DSH_HOME` file other than the single `AGENTS.md` is touched.
- No other `~/.agents` content is modified; existing user skills are untouched.
- No data leaves the machine; dependencies remain local.
- No skill is modified in place inside this repository.

## Behavior after install

- Every dsh session in every workspace receives the global instructions: end-of-task feedback records and failure run records, plus the safety boundaries.
- The `end-task-feedback` skill is discovered in every workspace.
- `dal` commands run from any directory; stores remain workspace-local (`.dal/...` relative to the working directory).

## Verification

1. `test -f ~/.agents/skills/end-task-feedback/SKILL.md`
2. `test -f ~/.dsh/AGENTS.md`
3. `command -v dal` resolves to the global prefix
4. `dal --help` exits 0
5. `pnpm dal approval verify <decision-file> --action change_shared_harness_config --scope <template-scope-digest> --at <now>` passes before the copy operations run

## Rollback

```sh
rm -rf ~/.agents/skills/end-task-feedback
rm -f ~/.dsh/AGENTS.md
npm uninstall -g dsh-adaptive-loop
```

Rollback restores the exact prior state: neither target path existed before this install.
