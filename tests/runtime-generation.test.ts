import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { jcsCanonicalJson } from "../src/json.js";
import {
  runtimeGenerationManifestSha256,
  validateRuntimeGenerationAttestation,
  validateRuntimeGenerationEvidence,
  validateRuntimeGenerationManifest,
} from "../src/runtime-generation.js";
import type { RuntimeGenerationEvidence, RuntimeGenerationManifest } from "../src/types.js";

const fixture = (...parts: string[]): string =>
  resolve(import.meta.dirname, "fixtures", "runtime-generation", ...parts);

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(fixture(name), "utf8")) as T;
}

describe("runtime generation contracts", () => {
  it("validates and deterministically digests a closed generation manifest", async () => {
    const manifest = await readFixture<RuntimeGenerationManifest>("manifest.json");
    await expect(validateRuntimeGenerationManifest(manifest)).resolves.toEqual(manifest);
    expect(runtimeGenerationManifestSha256(manifest)).toBe(
      "9da7af8cc4672fd3fcf19c1d958b3b205cb8a6175c064c7fc5b2bf77e86a8d2c",
    );
    expect(jcsCanonicalJson({ z: 1, a: "value" })).toBe('{"a":"value","z":1}');
    expect(() => jcsCanonicalJson({ value: "\ud800" })).toThrowError(
      expect.objectContaining({ code: "INVALID_IJSON_VALUE" }),
    );
  });

  it("rejects non-sequential composition and incomplete artifact closure", async () => {
    const manifest = await readFixture<RuntimeGenerationManifest>("manifest.json");
    manifest.loader_tree[0]!.ordinal = 1;
    manifest.resolver_receipts[0]!.artifact_sha256 = "e".repeat(64);
    await expect(validateRuntimeGenerationManifest(manifest)).rejects.toMatchObject({
      code: "RUNTIME_GENERATION_MANIFEST_INVALID",
      issues: expect.arrayContaining([
        "/loader_tree/0/ordinal must equal 0",
        "/resolver_receipts/0 must reference an artifact-closure uri and digest",
      ]),
    });
  });

  it("rejects duplicate object names before JSON parsing can erase them", async () => {
    const manifest = await readFixture<RuntimeGenerationManifest>("manifest.json");
    const raw = JSON.stringify(manifest).replace(
      '"schema_version":"1.0.0"',
      '"schema_version":"1.0.0","schema_version":"1.0.0"',
    );
    await expect(validateRuntimeGenerationManifest(manifest, raw)).rejects.toMatchObject({
      code: "RUNTIME_GENERATION_MANIFEST_INVALID",
      issues: expect.arrayContaining([
        expect.stringContaining("I-JSON object contains duplicate key"),
      ]),
    });
  });

  it("validates verified evidence and records a transition-spanning session as unstable", async () => {
    const evidence = await readFixture<RuntimeGenerationEvidence>("evidence-verified.json");
    await expect(validateRuntimeGenerationEvidence(evidence)).resolves.toEqual(evidence);
    await expect(validateRuntimeGenerationAttestation(
      await readFixture<RuntimeGenerationManifest>("manifest.json"),
      evidence,
    )).resolves.toMatchObject({ manifest_sha256: evidence.manifest_sha256 });

    const unstable = structuredClone(evidence);
    unstable.session_binding.final_transition_sequence += 1;
    unstable.stable_for_session = false;
    unstable.claims.find((claim) => claim.id === "session-binding")!.status = "failed";
    await expect(validateRuntimeGenerationEvidence(unstable)).resolves.toEqual(unstable);
  });

  it("rejects false stability and assurance without its required claims", async () => {
    const evidence = await readFixture<RuntimeGenerationEvidence>("evidence-verified.json");
    evidence.stable_for_session = false;
    evidence.claims.find((claim) => claim.id === "resolver-closure")!.status = "unavailable";
    evidence.claims.find((claim) => claim.id === "resolver-closure")!.evidence = [];
    await expect(validateRuntimeGenerationEvidence(evidence)).rejects.toMatchObject({
      code: "RUNTIME_GENERATION_EVIDENCE_INVALID",
      issues: expect.arrayContaining([
        "/stable_for_session must reflect the session transition sequence",
        "/claims/resolver-closure must be passed for verified assurance",
      ]),
    });
  });

  it("rejects evidence that does not bind the canonical manifest digest", async () => {
    const manifest = await readFixture<RuntimeGenerationManifest>("manifest.json");
    const evidence = await readFixture<RuntimeGenerationEvidence>("evidence-verified.json");
    evidence.manifest_sha256 = "0".repeat(64);
    await expect(validateRuntimeGenerationAttestation(manifest, evidence)).rejects.toMatchObject({
      code: "RUNTIME_GENERATION_ATTESTATION_INVALID",
    });
  });
});
