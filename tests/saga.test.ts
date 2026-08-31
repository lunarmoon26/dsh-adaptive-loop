import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { beginSaga, completeSaga, listSagas, sagaStatus } from "../src/saga.js";
import { sha256 } from "../src/json.js";

function captureIo(): { stdout: string[]; stderr: string[]; io: { stdout(text: string): void; stderr(text: string): void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("exactly-once effect sagas", () => {
  it("records an intent once and reports it pending before completion", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-saga-"));
    const first = await beginSaga({
      intentId: "int-demo-ingest",
      action: "ingest_feedback",
      payloadRef: "file:///tmp/payload.json",
      payloadSha256: "a".repeat(64),
      store,
    });
    expect(first.status).toBe("recorded");
    const retry = await beginSaga({
      intentId: "int-demo-ingest",
      action: "ingest_feedback",
      payloadRef: "file:///tmp/payload.json",
      payloadSha256: "a".repeat(64),
      store,
    });
    expect(retry.status).toBe("idempotent");

    const status = await sagaStatus({ intentId: "int-demo-ingest", store });
    expect(status.state).toBe("pending");
    expect(status.intent?.action).toBe("ingest_feedback");
    expect(status.receipt).toBeNull();
  });

  it("completes exactly once and refuses a conflicting second receipt", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-saga-"));
    await beginSaga({
      intentId: "int-demo-run",
      action: "ingest_run",
      payloadRef: "file:///tmp/run.json",
      payloadSha256: "b".repeat(64),
      store,
    });
    const completion = await completeSaga({
      intentId: "int-demo-run",
      outcome: "completed",
      receiptRef: "file:///tmp/run-store.json",
      receiptSha256: "c".repeat(64),
      store,
    });
    expect(completion.status).toBe("completed");
    const retry = await completeSaga({
      intentId: "int-demo-run",
      outcome: "completed",
      receiptRef: "file:///tmp/run-store.json",
      receiptSha256: "c".repeat(64),
      store,
    });
    expect(retry.status).toBe("idempotent");
    await expect(
      completeSaga({
        intentId: "int-demo-run",
        outcome: "failed",
        receiptRef: "file:///tmp/other.json",
        receiptSha256: "d".repeat(64),
        store,
      }),
    ).rejects.toMatchObject({ code: "SAGA_RECEIPT_CONFLICT" });

    const status = await sagaStatus({ intentId: "int-demo-run", store });
    expect(status.state).toBe("completed");
  });

  it("fails closed when completing an intent that was never recorded", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-saga-"));
    await expect(
      completeSaga({
        intentId: "int-never-begun",
        outcome: "completed",
        receiptRef: "file:///tmp/x.json",
        receiptSha256: "e".repeat(64),
        store,
      }),
    ).rejects.toMatchObject({ code: "SAGA_INTENT_MISSING" });
  });

  it("lists pending and completed sagas for crash-resume inspection", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-saga-"));
    await beginSaga({
      intentId: "int-pending",
      action: "publish_scorecard",
      payloadRef: "file:///tmp/s.json",
      payloadSha256: "f".repeat(64),
      store,
    });
    await beginSaga({
      intentId: "int-done",
      action: "publish_cluster",
      payloadRef: "file:///tmp/c.json",
      payloadSha256: "0".repeat(64),
      store,
    });
    await completeSaga({
      intentId: "int-done",
      outcome: "completed",
      receiptRef: "file:///tmp/c-receipt.json",
      receiptSha256: "1".repeat(64),
      store,
    });
    const listed = await listSagas({ store });
    expect(listed.map((entry) => entry.state).sort()).toEqual(["completed", "pending"]);
  });

  it("exposes begin, complete, and status through the CLI", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-saga-"));
    const payloadPath = join(store, "payload.json");
    await writeFile(payloadPath, '{"task":"demo"}\n', "utf8");
    const receiptPath = join(store, "receipt.json");
    await writeFile(receiptPath, '{"status":"stored"}\n', "utf8");

    const begin = captureIo();
    expect(
      await runCli(["saga", "begin", "--intent", "int-cli-001", "--action", "ingest_run", "--payload", payloadPath, "--store", store], begin.io),
    ).toBe(0);
    expect(JSON.parse(begin.stdout.join(""))).toMatchObject({ status: "recorded" });

    const complete = captureIo();
    expect(
      await runCli(["saga", "complete", "--intent", "int-cli-001", "--outcome", "completed", "--receipt", receiptPath, "--store", store], complete.io),
    ).toBe(0);
    expect(JSON.parse(complete.stdout.join(""))).toMatchObject({ status: "completed" });

    const status = captureIo();
    expect(await runCli(["saga", "status", "--intent", "int-cli-001", "--store", store], status.io)).toBe(0);
    expect(JSON.parse(status.stdout.join(""))).toMatchObject({ state: "completed" });

    const stored = JSON.parse(await readFile(join(store, "int-cli-001.intent.json"), "utf8")) as { payload_sha256: string };
    expect(stored.payload_sha256).toBe(sha256(await readFile(payloadPath)));
  });
});
