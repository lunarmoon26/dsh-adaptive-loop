import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCapsulePath, validateCapsule } from "../src/capsule.js";
import type { KnowledgeCapsule } from "../src/types.js";

const capsuleDirectory = resolve(import.meta.dirname, "..", "capsules");
const capsulePath = resolve(capsuleDirectory, "dal-v0-contract.json");
const validationTime = new Date("2026-09-02T16:00:00.000Z");

async function readCapsule(): Promise<KnowledgeCapsule> {
  return JSON.parse(await readFile(capsulePath, "utf8")) as KnowledgeCapsule;
}

describe("knowledge capsules", () => {
  it("validates every committed capsule against fresh local sources", async () => {
    const results = await checkCapsulePath(capsuleDirectory, validationTime);
    expect(results.map((result) => result.capsule_id)).toEqual([
      "capsule-dal-v0-contract",
      "capsule-dsh-adapter-boundary",
      "capsule-dsh-plugin-contract",
    ]);
  });

  it("fails closed when a source digest drifts", async () => {
    const capsule = await readCapsule();
    capsule.sources[0]!.sha256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    await expect(
      validateCapsule(capsule, capsulePath, validationTime),
    ).rejects.toMatchObject({ code: "CAPSULE_INVALID" });
  });

  it("fails closed after the refresh date", async () => {
    const capsule = await readCapsule();

    const expiredAt = new Date(`${capsule.refresh_after}T00:00:00.000Z`);
    expiredAt.setUTCDate(expiredAt.getUTCDate() + 1);
    await expect(validateCapsule(capsule, capsulePath, expiredAt)).rejects.toMatchObject({ code: "CAPSULE_INVALID" });
  });
});
