import { DalError } from "./errors.js";
import { assertIJsonText, canonicalJson, jcsCanonicalJson, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { RuntimeGenerationEvidence, RuntimeGenerationManifest } from "./types.js";

const OBSERVED_CLAIMS = ["effective-config", "launcher-composition"] as const;
const VERIFIED_CLAIMS = ["artifact-closure", "effective-config", "launcher-composition", "resolver-closure"] as const;

export async function validateRuntimeGenerationManifest(
  value: unknown,
  rawText?: string,
): Promise<RuntimeGenerationManifest> {
  await assertSchema(SCHEMA_IDS.runtimeGenerationManifest, value, "Runtime generation manifest");
  const manifest = value as RuntimeGenerationManifest;
  const issues: string[] = [];

  assertSequentialOrdinals(issues, "/loader_tree", manifest.loader_tree);
  assertSequentialOrdinals(issues, "/resolver_receipts", manifest.resolver_receipts);
  duplicateIssues(issues, "/loader_tree", manifest.loader_tree.map((entry) => entry.path), "path");
  duplicateIssues(
    issues,
    "/resolver_receipts",
    manifest.resolver_receipts.map((receipt) => `${receipt.parent_uri}\u0000${receipt.specifier}`),
    "request identity",
  );
  duplicateIssues(
    issues,
    "/artifacts",
    manifest.artifacts.map((artifact) => artifact.uri),
    "uri",
  );
  const artifacts = new Set(manifest.artifacts.map((artifact) => `${artifact.uri}\u0000${artifact.sha256}`));
  const referenced = [
    { path: "/launcher", uri: manifest.launcher.uri, sha256: manifest.launcher.sha256 },
    ...manifest.loader_tree.map((entry, index) => ({
      path: `/loader_tree/${index}`,
      uri: entry.resolved_uri,
      sha256: entry.artifact_sha256,
    })),
    ...manifest.resolver_receipts.map((receipt, index) => ({
      path: `/resolver_receipts/${index}`,
      uri: receipt.resolved_uri,
      sha256: receipt.artifact_sha256,
    })),
  ];
  for (const reference of referenced) {
    if (!artifacts.has(`${reference.uri}\u0000${reference.sha256}`)) {
      issues.push(`${reference.path} must reference an artifact-closure uri and digest`);
    }
  }
  if (!isSorted(manifest.artifacts.map((artifact) => canonicalJson(artifact)))) {
    issues.push("/artifacts must be canonically sorted");
  }
  assertJcsValue(issues, manifest, rawText);
  if (issues.length > 0) {
    throw new DalError("RUNTIME_GENERATION_MANIFEST_INVALID", "Runtime generation manifest violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(manifest, rawText));
  assertNoPii(scanPii(manifest, rawText));
  return manifest;
}

export async function validateRuntimeGenerationEvidence(
  value: unknown,
  rawText?: string,
): Promise<RuntimeGenerationEvidence> {
  await assertSchema(SCHEMA_IDS.runtimeGenerationEvidence, value, "Runtime generation evidence");
  const evidence = value as RuntimeGenerationEvidence;
  const issues: string[] = [];
  const claims = new Map(evidence.claims.map((claim) => [claim.id, claim]));

  duplicateIssues(issues, "/claims", evidence.claims.map((claim) => claim.id), "id");
  if (!isSorted(evidence.claims.map((claim) => claim.id))) {
    issues.push("/claims must be sorted by id");
  }
  evidence.claims.forEach((claim, index) => {
    if (!isSorted(claim.evidence)) {
      issues.push(`/claims/${index}/evidence must be sorted`);
    }
    if (claim.status !== "unavailable" && claim.evidence.length === 0) {
      issues.push(`/claims/${index}/evidence must not be empty when status is ${claim.status}`);
    }
    if (claim.status === "unavailable" && claim.evidence.length > 0) {
      issues.push(`/claims/${index}/evidence must be empty when status is unavailable`);
    }
  });
  const expectedStable =
    evidence.session_binding.bound_transition_sequence === evidence.session_binding.final_transition_sequence;
  if (evidence.session_binding.final_transition_sequence < evidence.session_binding.bound_transition_sequence) {
    issues.push("/session_binding/final_transition_sequence must not precede the bound transition sequence");
  }
  if (evidence.stable_for_session !== expectedStable) {
    issues.push("/stable_for_session must reflect the session transition sequence");
  }
  const sessionClaim = claims.get("session-binding");
  const expectedSessionStatus = expectedStable ? "passed" : "failed";
  if (sessionClaim?.status !== expectedSessionStatus) {
    issues.push(`/claims/session-binding must have status ${expectedSessionStatus}`);
  }
  const requiredClaims = evidence.assurance === "verified"
    ? VERIFIED_CLAIMS
    : evidence.assurance === "observed"
      ? OBSERVED_CLAIMS
      : [];
  for (const claimId of requiredClaims) {
    if (claims.get(claimId)?.status !== "passed") {
      issues.push(`/claims/${claimId} must be passed for ${evidence.assurance} assurance`);
    }
  }
  assertJcsValue(issues, evidence, rawText);
  if (issues.length > 0) {
    throw new DalError("RUNTIME_GENERATION_EVIDENCE_INVALID", "Runtime generation evidence violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(evidence, rawText));
  assertNoPii(scanPii(evidence, rawText));
  return evidence;
}

export async function validateRuntimeGenerationAttestation(
  manifestValue: unknown,
  evidenceValue: unknown,
  raw?: { manifest?: string; evidence?: string },
): Promise<{
  manifest: RuntimeGenerationManifest;
  evidence: RuntimeGenerationEvidence;
  manifest_sha256: string;
}> {
  const manifest = await validateRuntimeGenerationManifest(manifestValue, raw?.manifest);
  const evidence = await validateRuntimeGenerationEvidence(evidenceValue, raw?.evidence);
  const manifestSha256 = runtimeGenerationManifestSha256(manifest);
  const issues: string[] = [];
  if (evidence.manifest_sha256 !== manifestSha256) {
    issues.push("/manifest_sha256 does not match the RFC 8785 canonical manifest");
  }
  if (evidence.digest_profile !== manifest.digest_profile) {
    issues.push("/digest_profile does not match the manifest digest profile");
  }
  if (issues.length > 0) {
    throw new DalError("RUNTIME_GENERATION_ATTESTATION_INVALID", "Runtime generation evidence does not bind its manifest", issues);
  }
  return { manifest, evidence, manifest_sha256: manifestSha256 };
}

export function runtimeGenerationManifestSha256(manifest: RuntimeGenerationManifest): string {
  return sha256(jcsCanonicalJson(manifest));
}

function assertSequentialOrdinals(
  issues: string[],
  path: string,
  entries: ReadonlyArray<{ ordinal: number }>,
): void {
  entries.forEach((entry, index) => {
    if (entry.ordinal !== index) {
      issues.push(`${path}/${index}/ordinal must equal ${index}`);
    }
  });
}

function duplicateIssues(issues: string[], path: string, values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    issues.push(`${path} contains duplicate ${label} values`);
  }
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

function assertJcsValue(issues: string[], value: unknown, rawText?: string): void {
  try {
    if (rawText !== undefined) assertIJsonText(rawText);
    jcsCanonicalJson(value);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "value is not valid I-JSON");
  }
}
