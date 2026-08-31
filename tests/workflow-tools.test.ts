import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changeBooking,
  createReturnLabel,
  getEffectStatus,
  issueRefund,
  loadState,
  projectServiceState,
  refuseRequest,
  type ServiceEnvironment,
} from "../benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools/src/service.js";

async function environment(faults: ServiceEnvironment["faults"] = {}): Promise<ServiceEnvironment> {
  return { stateRoot: await mkdtemp(join(tmpdir(), "dal-workflow-service-")), faults };
}

async function seeded(faults: ServiceEnvironment["faults"] = {}): Promise<ServiceEnvironment> {
  const env = await environment(faults);
  const state = await loadState(env);
  state.orders["o-1001"] = { status: "delivered", total: 120, days_since_delivery: 12, items: ["sku-a", "sku-b"] };
  state.bookings["b-5001"] = { route: "SFO-EWR", date: "2026-08-01", status: "departed", seats: 1, changes: 0 };
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const target = resolve(env.stateRoot, "state.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`);
  return env;
}

describe("mock order/booking service", () => {
  it("issues a refund, updates state, and replays idempotently", async () => {
    const env = await seeded();
    const first = await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-1" });
    expect(first.outcome).toBe("success");
    expect(first.idempotent).toBe(false);
    expect(first.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    const state = await loadState(env);
    expect(state.refunds).toHaveLength(1);
    expect(state.orders["o-1001"]?.status).toBe("refunded");

    const replay = await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-1" });
    expect(replay.idempotent).toBe(true);
    expect(replay.receipt_sha256).toBe(first.receipt_sha256);
    expect((await loadState(env)).refunds).toHaveLength(1);
  });

  it("enforces the written policy at the service boundary", async () => {
    const env = await seeded();
    const over = await issueRefund(env, { order_id: "o-1001", amount: 500, reason: "damaged", idempotency_key: "r-2" });
    expect(over.outcome).toBe("definite_failure");
    expect((await loadState(env)).refunds).toHaveLength(0);

    const departed = await changeBooking(env, { booking_id: "b-5001", new_route: "SFO-JFK", idempotency_key: "b-1" });
    expect(departed.outcome).toBe("definite_failure");
    expect((await loadState(env)).bookings["b-5001"]?.route).toBe("SFO-EWR");
  });

  it("simulates unknown outcomes without mutating state", async () => {
    const env = await seeded({ issue_refund: "unknown" });
    const unknown = await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-3" });
    expect(unknown.outcome).toBe("unknown");
    expect((await loadState(env)).refunds).toHaveLength(0);

    const status = await getEffectStatus(env, "r-3");
    expect(status).toMatchObject({ found: true, outcome: "unknown" });

    const retry = await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-3" });
    expect(retry.idempotent).toBe(true);
    expect((await loadState(env)).refunds).toHaveLength(0);
  });

  it("creates labels, changes bookings, and records refusals", async () => {
    const env = await seeded();
    const label = await createReturnLabel(env, { order_id: "o-1001", idempotency_key: "l-1" });
    expect(label.outcome).toBe("success");
    const changed = await changeBooking(env, { booking_id: "b-5001", new_route: "SFO-EWR", idempotency_key: "b-2" });
    expect(changed.outcome).toBe("definite_failure");
    const refusal = await refuseRequest(env, { kind: "booking_change", target: "b-5001", reason: "departed", idempotency_key: "f-1" });
    expect(refusal.outcome).toBe("success");
    const state = await loadState(env);
    expect(state.labels).toHaveLength(1);
    expect(state.bookings["b-5001"]?.changes).toBe(0);
  });

  it("resolves unknown outcomes on status query without double-applying", async () => {
    const env = await seeded({ issue_refund: "unknown" });
    env.resolutions = { issue_refund: "success" };
    const unknown = await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-5" });
    expect(unknown.outcome).toBe("unknown");

    const status = await getEffectStatus(env, "r-5");
    expect(status.outcome).toBe("success");
    const state = await loadState(env);
    expect(state.refunds).toHaveLength(1);

    const again = await getEffectStatus(env, "r-5");
    expect(again.outcome).toBe("success");
    expect((await loadState(env)).refunds).toHaveLength(1);
  });


  it("keeps the order status unchanged on partial refunds", async () => {
    const env = await seeded();
    const partial = await issueRefund(env, { order_id: "o-1001", amount: 30, reason: "faulty-item", idempotency_key: "r-6" });
    expect(partial.outcome).toBe("success");
    const state = await loadState(env);
    expect(state.orders["o-1001"]?.status).toBe("delivered");
    expect(state.refunds).toHaveLength(1);
  });

  it("projects the service state through the output convention for grading", async () => {
    const env = await seeded();
    await issueRefund(env, { order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "r-4" });
    const projected = projectServiceState(await loadState(env));
    expect(projected.orders["o-1001"]).toEqual({ status: "refunded" });
    expect(projected.bookings["b-5001"]).toEqual({ route: "SFO-EWR", changes: 0 });
  });
});

describe("G0 skill gap guard", () => {
  it("keeps the G0 skill free of unknown-outcome guidance (the deliberate gap)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const skill = await readFile(
      resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow", ".agents", "skills", "refund-workflow", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("idempotency_key");
    expect(skill).not.toContain("get_effect_status");
    expect(skill).not.toContain("unknown");
  });
});
