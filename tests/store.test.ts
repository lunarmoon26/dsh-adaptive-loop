import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ingestFeedback, queryFeedback, summarizeFeedback } from "../src/store.js";
import type { FeedbackLog, StoredFeedbackRecord } from "../src/types.js";

const fixture = (name: string): string => resolve(import.meta.dirname, "fixtures", "feedback", name);

async function readFeedback(name: string): Promise<FeedbackLog> {
  return JSON.parse(await readFile(fixture(name), "utf8")) as FeedbackLog;
}

describe("immutable feedback store", () => {
  it("stores, reuses, queries, and summarizes validated records", async () => {
    const store = await mkdtemp(join(tmpdir(), "dal-feedback-store-"));
    const completed = await ingestFeedback(fixture("completed.json"), store);
    const repeated = await ingestFeedback(fixture("completed.json"), store);
    await ingestFeedback(fixture("blocked.json"), store);
    await ingestFeedback(fixture("aborted.json"), store);

    expect(completed.status).toBe("stored");
    expect(repeated.status).toBe("idempotent");
    const persisted = JSON.parse(await readFile(completed.path, "utf8")) as StoredFeedbackRecord;
    expect(persisted.privacy_scan).toMatchObject({
      status: "passed",
      ruleset_version: "secret-ruleset-2026-08-27-v1",
      pii_ruleset_version: "pii-ruleset-2026-08-27-v1",
    });

    const blocked = await queryFeedback({ outcome: "blocked" }, store);
    expect(blocked.map((record) => record.record_id)).toEqual(["fb-blocked-example"]);
    expect(summarizeFeedback(await queryFeedback({}, store))).toEqual({
      total_records: 3,
      outcomes: { completed: 1, blocked: 1, aborted: 1 },
      inefficiencies: { total: 1, by_category: { coordination: 1 } },
    });
  });

  it("rejects conflicting content for an existing feedback ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-feedback-conflict-"));
    const store = join(root, "store");
    await ingestFeedback(fixture("completed.json"), store);
    const changed = await readFeedback("completed.json");
    changed.goal = "Different content under the same immutable identifier.";
    const changedPath = join(root, "changed.json");
    await writeFile(changedPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await expect(ingestFeedback(changedPath, store)).rejects.toMatchObject({ code: "FEEDBACK_ID_CONFLICT" });
  });

  it.each([
    ["SECRET_DETECTED", "ghp_1234567890abcdefghij"],
    ["PII_DETECTED", "sample-person@example.test"],
  ])("rejects %s before creating a durable record", async (code, sensitiveValue) => {
    const root = await mkdtemp(join(tmpdir(), "dal-feedback-sensitive-"));
    const store = join(root, "store");
    const feedback = await readFeedback("completed.json");
    feedback.feedback_id = `fb-sensitive-${code.toLowerCase().replaceAll("_", "-")}`;
    feedback.goal = `Sensitive fixture: ${sensitiveValue}`;
    const source = join(root, "source.json");
    await writeFile(source, `${JSON.stringify(feedback, null, 2)}\n`, "utf8");

    await expect(ingestFeedback(source, store)).rejects.toMatchObject({ code });
    await expect(access(join(store, `${feedback.feedback_id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["SECRET_DETECTED", "ghp_1234567890abcdefghij.json"],
    ["PII_DETECTED", "sample-person@example.test.json"],
  ])("rejects %s in source provenance before publishing the envelope", async (code, filename) => {
    const root = await mkdtemp(join(tmpdir(), "dal-feedback-source-path-"));
    const store = join(root, "store");
    const feedback = await readFeedback("completed.json");
    feedback.feedback_id = `fb-path-${code.toLowerCase().replaceAll("_", "-")}`;
    const source = join(root, filename);
    await writeFile(source, `${JSON.stringify(feedback, null, 2)}\n`, "utf8");

    await expect(ingestFeedback(source, store)).rejects.toMatchObject({ code });
    await expect(access(join(store, `${feedback.feedback_id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
