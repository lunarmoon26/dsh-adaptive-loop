# Multi-provider matrix (tau-style workflow)

The e2e driver can run the same pass@k batches against any provider whose
route the harness can serve. DeepSeek runs through the in-box
`dsh-llm-deepseek` adapter; every other provider runs through the in-box
`dsh-llm-pi-ai` multi-provider adapter, which ships catalog routes for
`openai`, `anthropic`, `zai` (Z.ai / GLM), and `moonshotai` (Kimi) at the
same harness version. Benchmark-integrity runs target the local
`dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2` image; rebuilding it changes
the approval scope and requires fresh evidence.

## How the wiring works

`buildCompositionPatch` emits, for any non-deepseek provider, one extra
composition row:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai:          # route key; anthropic | zai | moonshotai likewise
        apiKeyEnv: OPENAI_API_KEY
```

plus the usual `agent-default-model` row naming `provider` and `model`. The
`llm-pi-ai` row is mounted dormant by `dsh-base`; declaring a provider
profile registers the route live at mount, and the adapter resolves the
credential per request through the credential seam — the driver passes the
named env var into the container with `docker run -e`. A route profile that
omits `models` serves the pi-ai installed catalog unchanged (endpoint,
protocol, and model ids all come from the catalog), so only the credential
reference is required.

## Providers and defaults

| `--provider`    | route        | key env             | default `--model`          |
| --------------- | ------------ | ------------------- | -------------------------- |
| `deepseek-official` | deepseek-official | `DEEPSEEK_API_KEY` | `deepseek-v4-flash`        |
| `openai`        | `openai`      | `OPENAI_API_KEY`    | `gpt-5.6-luna`             |
| `anthropic`     | `anthropic`   | `ANTHROPIC_API_KEY` | `claude-sonnet-5`          |
| `zai`           | `zai`         | `ZAI_API_KEY`       | `glm-5.2`                  |
| `moonshotai`    | `moonshotai`  | `MOONSHOT_API_KEY`  | `kimi-k3`                  |

Model ids are the pi-ai catalog entries shipped with dsh `0.1.1-rc.2`
(OpenAI models ride the `openai-responses` protocol, Anthropic the
`anthropic-messages` protocol, Z.ai and Moonshot `openai-completions`).

## Running a provider batch

1. Put the provider key in the repo `.env` (gitignored) or export it:

   ```sh
   OPENAI_API_KEY=sk-...   # or ANTHROPIC_API_KEY / ZAI_API_KEY / MOONSHOT_API_KEY
   ```

2. Approve the batch: the approval decision binds the full transmission
   manifest — provider, model, generation, rollout count, runner,
   fault/resolution profile, immutable container image and baked workflow-tools
   digests, agent-visible and evaluator-task digests, driver-source digests,
   policy, skill, exact rendered composition-patch text, and prompts — so every
   provider/model pair, and every skill or image change, needs its own
   approved, unexpired `send_data_externally` decision. Compute the scope
   digest first:

   ```sh
   pnpm benchmark:e2e manifest-digest --provider openai --model gpt-5.6-luna
   ```

3. Run (same flags as the deepseek batches):

   ```sh
   pnpm benchmark:e2e \
     --approval <decision-file> \
     --provider openai --model gpt-5.6-luna \
     --batch openai-passk-YYYYMMDD --generation g1 \
     --attempts 5 --faults issue_refund=unknown \
     --resolutions issue_refund=success \
      --compare .dal/check/e2e-summary-g1-passk-YYYYMMDD.json
   ```

   The exact approved manifest is stored under `.dal/check/e2e-manifests/`,
   revalidated before each attempt, and bound into every receipt. The
   `--compare` gate then judges the provider batch against the reference
   summary with the same manifest/receipt checks. It requires the same frozen
   benchmark-context and candidate digests for a same-generation provider
   comparison; a harness-generation comparison instead requires the model to
   remain fixed. Every attempt uses the
   candidate/service/grader isolation topology; `--runner local` is refused
   because it cannot keep the oracle outside the candidate process.

## Credential failure mode

A missing key fails the run before any model call: the driver throws
`Provider "<provider>" needs <KEY>; set it in the environment or <repo>/.env
before running`. Credential values never appear in run records, receipts,
summaries, or logs.

The candidate container needs outbound access to the selected provider and
receives that provider's key. Its network is not destination-allowlisted, so
the topology proof protects evaluator artifacts but is not credential-egress
confinement. Use a dedicated short-lived benchmark credential and rotate it
after any suspected candidate-process compromise.
