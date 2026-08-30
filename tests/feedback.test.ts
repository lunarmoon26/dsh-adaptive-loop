import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateFeedback, validateFeedbackDocument } from "../src/feedback.js";
import { scanPii } from "../src/privacy.js";
import type { FeedbackLog } from "../src/types.js";

const fixture = (name: string): string => resolve(import.meta.dirname, "fixtures", "feedback", name);

async function completedFeedback(): Promise<FeedbackLog> {
  return JSON.parse(await readFile(fixture("completed.json"), "utf8")) as FeedbackLog;
}

describe("feedback validation", () => {
  it.each(["completed.json", "blocked.json", "aborted.json"])("accepts %s", async (name) => {
    const result = await validateFeedbackDocument(fixture(name));
    expect(result.feedback.outcome.status).toBe(name.replace(".json", ""));
  });

  it("rejects a completed record with a failed criterion", async () => {
    const feedback = await completedFeedback();
    feedback.acceptance_criteria[0]!.result = "failed";

    await expect(validateFeedback(feedback)).rejects.toMatchObject({ code: "FEEDBACK_SEMANTIC_INVALID" });
    await expect(validateFeedbackDocument(fixture("invalid-completed.json"))).rejects.toMatchObject({
      code: "FEEDBACK_SEMANTIC_INVALID",
    });
  });

  it("rejects secret-bearing content", async () => {
    const feedback = await completedFeedback();
    feedback.goal = "Do not persist ghp_1234567890abcdefghij";

    await expect(validateFeedback(feedback)).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    await expect(validateFeedbackDocument(fixture("secret.json"))).rejects.toMatchObject({
      code: "SECRET_DETECTED",
    });
  });

  it("rejects likely personal data", async () => {
    const feedback = await completedFeedback();
    feedback.goal = "Contact sample-person@example.test before persisting.";

    await expect(validateFeedback(feedback)).rejects.toMatchObject({ code: "PII_DETECTED" });
  });

  it("does not interpret SHA-256 provenance as a payment card", () => {
    const value = {
      fixture_set_sha256: "4111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(scanPii(value, JSON.stringify(value))).toEqual([]);
    expect(scanPii({ value: "4111 1111 1111 1111" })).toEqual([
      { path: "/value", rule: "payment-card-number" },
    ]);
  });
});
