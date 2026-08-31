# 0002: Deterministic guardrails precede evaluation and human authority remains separate

Status: Accepted
Date: 2026-08-27
Related: [`../evaluation-and-guardrails.md`](../evaluation-and-guardrails.md), [`../governance.md`](../governance.md), [`0001-local-staged-improvement.md`](0001-local-staged-improvement.md)

## Context

Prompt injection, untrusted repository content, sensitive data, unsafe tools, compromised plugins, and optimizer reward hacking can all produce plausible-looking successful evaluations. Model grading is probabilistic and finite fixtures can be contaminated or gamed. The system needs useful offline evaluation without allowing a score to become authority.

## Decision

Run schema, privacy, capability, sandbox-declaration, budget, provenance, quarantine, and exact-approval checks deterministically before considering evaluation scores. Record requests and scorecards immutably. Model/judge output is optional evidence only. Require human review for human-only lifecycle stages and a separate exact approval at every sensitive execution boundary. Keep every action executor outside v0.

## Alternatives considered

- **Model guard or judge as the primary gate:** flexible for novel text, but non-deterministic, injectable, costly, and unable to establish organizational authority. Rejected.
- **External policy/evaluation platforms in v0:** mature options exist, but add binaries, providers, network paths, plugins, and supply-chain surface before local requirements are measured. Deferred behind the JSON boundaries.
- **Tests only, no runtime policy record:** simpler, but cannot prove which policy and request were evaluated at an operation boundary. Rejected.

## Consequences

- Positive: unsafe requests and sensitive data fail locally with reproducible reasons.
- Positive: evaluation can improve without acquiring mutation or approval authority.
- Positive: policy, fixture, artifact, and result digests make contamination and drift reviewable.
- Negative: deterministic rules miss semantic attacks and can reject benign PII-shaped text.
- Negative: v0 records sandbox declarations but does not provide an OS sandbox or dsh lifecycle enforcement.
- Negative: maintainers must curate adversarial and golden fixtures and review quarantine releases.

## Conformance

- Tests cover an allowed local path, secret/PII rejection, unapproved candidate-application rejection, budget denial, scorecard hard stops, and human-only transitions.
- The dependency graph contains no model SDK, network client, policy daemon, plugin installer, or optimizer runtime.
- A passing model/judge field cannot alter deterministic effects or approval verification.
