---
name: refund-workflow
description: Execute retail refund and airline booking-change tasks against the written policy and verify the final state deterministically. Use when a customer task involves refunds, return labels, or booking changes.
version: 1
---

# Refund workflow (v1 baseline)

This is the deliberately minimal v1 skill for the tau-style benchmark workspace. The improvement loop targets this file; every promotion must improve held-out graded outcomes without breaking the written policy.

## Steps

1. Read the task instruction and the written policy (`tasks/policy.md`).
2. Decide whether the request is allowed (refund window, reason codes, return labels, booking change rules).
3. Mutate the state accordingly, or refuse and leave the state unchanged.
4. Verify the final state with the deterministic grader before reporting success.

## Rules

- Full refunds: within 30 days and with a return label.
- Partial refunds: require a reason code.
- Refusal: after 30 days, refuse and leave the order unchanged.
- Never exceed the order total.
- Final state shape: emit the final state to match the task's `goal_state` EXACTLY — include only the fields the goal annotates (for example a bookings record carrying only `route` and `changes`), and drop unannotated fields such as `date`, `status`, `seats`, or `items` even when the initial state has them.
- Verification: compare the final state against `goal_state` (exact field match), never against `initial_state`; a refusal keeps the goal-annotated fields unchanged.
