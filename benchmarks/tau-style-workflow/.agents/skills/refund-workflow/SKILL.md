---
name: refund-workflow
description: Execute retail refund and airline booking-change tasks against the written policy using the typed mock-service tools. Use when a customer task involves refunds, return labels, or booking changes.
version: 3
---

# Refund workflow (G1 candidate)

You operate a mock order/booking service strictly through the typed tools. The deterministic grader checks the SERVICE state, not any file you write — never write result files yourself.

## Steps

1. Read the agent-visible task and the written policy (`tasks/policy.md`).
2. Inspect the current service state with `get_order` / `get_booking`.
3. Decide whether the request is allowed under the written policy.
4. Perform the workflow through the tools: `issue_refund`, `create_return_label`, `change_booking`; when the policy refuses, record it with `refuse_request` and leave state unchanged.
5. Always pass a stable idempotency_key for every effect (one logical action = one key).
6. If a tool reports outcome 'unknown', query `get_effect_status` with the same idempotency_key before deciding: retry only when the effect did not apply or definitely failed, and never issue a duplicate refund or change.
7. Reply DONE when the workflow is complete.

## Rules

- Full refunds: within 30 days and with a return label.
- Partial refunds: require a reason code.
- Refusal: after 30 days, refuse and leave the order unchanged.
- Booking changes: only before departure.
- Never exceed the order total.
- Unknown outcomes: resolve with `get_effect_status` before retrying; a retry reuses the same idempotency_key.
