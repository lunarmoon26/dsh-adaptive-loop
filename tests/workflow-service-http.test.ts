import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { remoteWorkflowService } from "../benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools/src/client.js";
import { createWorkflowServiceServer } from "../benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools/src/server.js";
import { initializeService, type ServiceEnvironment } from "../benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools/src/service.js";
import { gradeRemoteSnapshot } from "../src/workflow-grader-remote.js";

const workspace = resolve(import.meta.dirname, "..", "benchmarks", "tau-style-workflow");

describe("isolated workflow service HTTP boundary", () => {
  it("serves candidate tools while reserving the state/effect snapshot for the grader token", async () => {
    const env: ServiceEnvironment = {
      stateRoot: await mkdtemp(resolve(tmpdir(), "dal-workflow-http-")),
      faults: {},
    };
    await initializeService(env, {
      orders: { "o-1001": { status: "delivered", total: 120, days_since_delivery: 12, items: ["sku-a", "sku-b"] } },
      refunds: [],
      labels: [],
      bookings: {},
    });
    const token = "evaluator-token-that-is-at-least-32-characters";
    const server = createWorkflowServiceServer(env, { evaluatorToken: token });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = (server.address() as AddressInfo).port;
    const serviceUrl = `http://127.0.0.1:${port}`;
    try {
      const candidate = remoteWorkflowService(serviceUrl);
      await expect(candidate.getOrder("o-1001")).resolves.toMatchObject({ status: "delivered", total: 120 });
      await expect(candidate.createReturnLabel({ order_id: "o-1001", idempotency_key: "label-1" })).resolves.toMatchObject({ outcome: "success" });
      await expect(candidate.issueRefund({ order_id: "o-1001", amount: 120, reason: "damaged", idempotency_key: "refund-1" })).resolves.toMatchObject({ outcome: "success" });

      await expect(fetch(`${serviceUrl}/v1/evaluator/snapshot`)).resolves.toMatchObject({ status: 403 });
      const graded = await gradeRemoteSnapshot({
        taskPath: resolve(workspace, "tasks", "task-001-refund.json"),
        snapshotUrl: `${serviceUrl}/v1/evaluator/snapshot`,
        evaluatorToken: token,
      });
      expect(graded.verdict.pass).toBe(true);
      expect(graded.effects).toHaveLength(2);
      expect(graded.journal_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    }
  });
});
