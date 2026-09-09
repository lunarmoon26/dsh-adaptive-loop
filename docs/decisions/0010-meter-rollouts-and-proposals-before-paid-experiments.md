# 0010: Meter rollouts and proposals before paid experiments

Status: Accepted
Change: `chg-dal-paid-e2e-preflight-20260907`
Date: 2026-09-08

The user requires all preparation finished before paid OpenAI Terra and Anthropic
Sonnet experiments. Direct candidate-held API keys and timeouts cannot enforce a
campaign budget. Move keys into a broker; attach the DSH candidate only to an
internal Docker network. Only the live broker receives a designated key and
outbound network. The service and hidden grader retain their isolated roles.

Use the same canonical, durable campaign/provider ledger for rollout and proposal
requests. Admit only bounded inline text/custom-tool requests to fixed endpoints
and exact models. Reserve the complete conservative upper cost before transport,
keep reservations after failure, reject duplicate requests and never retry
automatically. The approved policy discloses the byte/token conversion and rate
assumptions rather than claiming invoice measurement or account-global control.

Build a minimal derived image from an existing local DSH image. Compile source
before staging, reject source changes during build, and verify source/schema and
compiled-file provenance against the immutable image before preparing approval.
Never use the repository or `.env` as Docker build context.

Rehearsal uses the real DSH loop and native streaming protocols with deterministic
fake responses, no provider keys and no outbound broker network. Its records live
outside the ordinary run store, with explicit mode evidence. Proposal preparation
rejects known rehearsal inputs, including older recognizable records. A successful
protocol rehearsal with a failed business oracle is reported as exactly that.

Prepare finite live manifests and pending approval requests, not fabricated human
decisions. Phase two's payload depends on real baseline evidence and receives a
fresh exact-digest approval. Generated drafts do not authorize activation.

Confirmation: adversarial broker/ledger tests, source/artifact drift tests, actual
keyless DSH execution for both providers, before/after daemon isolation inspection,
same-ledger metered proposals, finite manifest regeneration, and the full local
gate. The canonical evidence receipt records what actually ran.
