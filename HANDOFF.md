# Handoff notes (2026-08-31, session end)

Written by the coding agent at session end. The next agent should start
here. The repository history was rebaselined on request into a single
`Initial commit` and force-pushed to `main` on
`github.com/lunarmoon26/dsh-adaptive-loop`; all prior commit hashes
(including `058c0c0`, which used to hold the G0 baseline skill) are gone.
The G0 baseline skill content is preserved as
`benchmarks/tau-style-workflow/dal/fixtures/skill-g0-v1.md`.

## 0. Immediate state checks (do these first)

```sh
git -C /Users/haochuanzhang/Workspace/recursive-dev-loop status --short
# Should be clean. The pass@k demo job was stopped for the rebaseline;
# no leg is running and the G1 skill is at HEAD.
```

## 1. What is in the rebaselined HEAD (single commit)

- Cluster identity = failure fingerprint + run batch (additive `batch_id`,
  `dal cluster run --batch`); e2e driver `--attempts N` pass@k with
  per-batch summaries (per-task mean, pass@1, checkpoint-union, overall
  mean/variance) and `--compare` paired gate (task set match, mean and
  per-task non-regression, every receipt digest-valid and bound to its
  recorded state digest).
- Multi-provider wiring via the in-box `dsh-llm-pi-ai` adapter:
  `PROVIDERS` registry (deepseek-official → deepseek-v4-flash, openai →
  gpt-5.6-luna, anthropic → claude-sonnet-5, zai → glm-5.2, moonshotai →
  kimi-k3), `llm-pi-ai` composition row, fail-closed credential check.
- Receipts bind the real dsh headless session (`dsh_session_id`, session
  `event_log_head_sha256`, `business_effect_log_head_sha256`,
  `container_image_sha256`, `effective_composition_sha256` = patch + skill +
  tools bytes + image); `evaluateBranch` rejects task/verdict mismatches
  (`BRANCH_RECEIPT_MISMATCH`); `branchStats` counts only receipt-bound
  evaluations; the approval manifest binds provider/model/runner/faults/
  resolutions/image/policy/skill/tools-bytes/prompts.
- Driver resilience (docker health check, lingering-container cleanup, one
  reseeded retry); per-batch service state root (parallel provider batches
  safe).
- Clean unknown-outcome experiment surface: tool descriptions
  strategy-neutral; skill v3 (G1) teaches query-then-retry; `--resolutions`
  support; the manifest binds the tools bytes *inside* the executed image.
- Docs synced: `docs/governance.md`, `docs/spec.md`,
  `docs/operator-guide.md`, `docs/evaluation-and-guardrails.md`,
  `docs/architecture.md`, `deploy/docker/README.md`, `README.md`,
  `ROADMAP.md`, `benchmarks/tau-style-workflow/PROVIDERS.md`,
  `.env.example` (lists all five provider keys).
- Feedback records for every change task are ingested (`.dal/outbox/fb-*`
  plus store copies under `.dal/store/`).

## 2. Live pass@k demo (to run)

Approved, verified decisions in `.dal/outbox/` (all `send_data_externally`,
expiry 2026-09-03T00:00Z, all bound with `--faults issue_refund=unknown`):

| decision | batch | scope.value |
|---|---|---|
| `dec-g0-passk-20260831` | G0, deepseek-v4-flash, v1 skill | `1f934e8141704d35a8b5b400b305125d5e28eeffd83cbe60fe8e59aaabb2a73d` |
| `dec-g1-passk-20260831` | G1, deepseek-v4-flash, v3 skill | `ca0fd1920f2590b08021d4c11b9ccee4321f1366efb01a4beb0f2c9f5f82b919` |
| `dec-openai-passk-20260831` | openai / gpt-5.6-luna | `506b9e7a358338f1a4fa4602931c021e00348795570aa1586d4634a2a37a952c` |
| `dec-anthropic-passk-20260831` | anthropic / claude-sonnet-5 | `1ced79a28623b06cae38d0bbc334c0e8edce3dbd07709651754f42b396275ba0` |
| `dec-zai-passk-20260831` | zai / glm-5.2 | `95a60190fe83c5c523e80124f3e5cde2e66f17a61bdb6bc8e080551cecd882cd` |
| `dec-moonshotai-passk-20260831` | moonshotai / kimi-k3 | `0f097341df6d5a8a0c1b1523d9590fab88d9de4f90ebe08f4c1ab3ef0aff7e98` |

Commands (repo root; `CI=true` required):

```sh
# G0: swap in the v1 baseline skill from the fixture
cp benchmarks/tau-style-workflow/dal/fixtures/skill-g0-v1.md \
  benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md
CI=true pnpm benchmark:e2e --approval .dal/outbox/dec-g0-passk-20260831.json \
  --batch g0-passk-20260831b --attempts 5 --faults issue_refund=unknown --generation g0
git checkout -- benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md

# G1
CI=true pnpm benchmark:e2e --approval .dal/outbox/dec-g1-passk-20260831.json \
  --batch g1-passk-20260831b --attempts 5 --faults issue_refund=unknown --generation g1 \
  --compare .dal/check/e2e-summary-g0-passk-20260831b.json

# providers (run in parallel once G1's summary exists; keys are in .env)
CI=true pnpm benchmark:e2e --approval .dal/outbox/dec-openai-passk-20260831.json \
  --provider openai --model gpt-5.6-luna --batch openai-passk-20260831 --generation g1 \
  --attempts 5 --faults issue_refund=unknown \
  --compare .dal/check/e2e-summary-g1-passk-20260831b.json
# ...same shape for anthropic/claude-sonnet-5, zai/glm-5.2, moonshotai/kimi-k3
```

Notes:
- The driver prints `manifest digest: ...` before verifying the decision;
  it must match the table above, or something (skill/image/faults/model)
  drifted.
- Exit code 1 is expected for legs with any failed attempt; the verdict is
  the `compare pass|fail` line (G1) and the summary files.
- Observed rate: ~4–10 min/attempt; a 5-task×5-attempt leg is 2–5 h.
- If docker stalls: the driver relaunches Docker Desktop, kills lingering
  containers, reseeds the per-batch service state, and retries once per
  attempt. The pinned demo image is
  `dsh-adaptive-loop/dsh:0.1.1-rc.2-demo` id
  `sha256:2fca609a5f11bbc732167c419a378c9fa92be43fb755d1ca4a13606df28fa933`
  (sandbox probe passed after rebuild). Changing the image, skill, tasks,
  policy, tools plugin, faults, or model invalidates every digest above —
  recompute with `pnpm benchmark:e2e manifest-digest ...` and re-issue
  decisions.
- Run records land in `.dal/runs` (commit them after the batch), receipts in
  `.dal/check/e2e-receipts/`, summaries in `.dal/check/`.

## 3. Remaining work (deferred review items — see ROADMAP.md "Benchmark measurement integrity")

All post-demo (they change grader/tool semantics and would confound the
running comparison; each requires a `GRADER_VERSION` bump):

1. Split harness outcome from business outcome in run records.
2. Required/forbidden effects for refusal tasks (grader must require a
   `refuse_request` effect; task metadata evaluator-only).
3. Physical oracle isolation (staged read-only workspace + service as a
   separate principal; three-container topology).
4. Crash-safe service state (append-only effect journal as source of truth,
   or SQLite).
5. Bind the rendered composition-patch text in the approval manifest.
6. G2 harness-code adaptation (unknown-effect-guard Cordis plugin).

## 4. Gate caveat

Do NOT run `pnpm run check` while a demo leg has the v1 skill swapped into
the workspace — `tests/workflow-tools.test.ts` reads the workspace skill and
will fail. Restore the skill (section 0) first, then `CI=true pnpm run check`.

## 5. Session hygiene

- `.env` (gitignored) now holds all five keys: `DEEPSEEK_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`.
- Feedback records for every change task this session are ingested
  (`.dal/outbox/fb-*.json` + store copies under `.dal/store/`).
- History is a single `Initial commit` on `main`, force-pushed.
