import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { isNodeError, DalError } from "./errors.js";
import { readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { KnowledgeCapsule, Policy } from "./types.js";

export interface CapsuleCheckResult {
  path: string;
  capsule_id: string;
  capsule_version: string;
  source_count: number;
}

export async function checkCapsulePath(inputPath: string, now = new Date()): Promise<CapsuleCheckResult[]> {
  const paths = await capsuleFiles(resolve(process.cwd(), inputPath));
  if (paths.length === 0) {
    throw new DalError("CAPSULE_NOT_FOUND", `No JSON capsules found at ${inputPath}`);
  }
  const results: CapsuleCheckResult[] = [];
  for (const path of paths) {
    const capsule = await validateCapsuleFile(path, now);
    results.push({
      path,
      capsule_id: capsule.capsule_id,
      capsule_version: capsule.capsule_version,
      source_count: capsule.sources.length,
    });
  }
  return results;
}

export async function validateCapsuleFile(filePath: string, now = new Date()): Promise<KnowledgeCapsule> {
  const policy = await loadPolicy();
  const { value, raw } = await readJsonFile<unknown>(filePath);
  return validateCapsule(value, filePath, now, policy, raw.toString("utf8"));
}

export async function validateCapsule(
  value: unknown,
  filePath: string,
  now = new Date(),
  suppliedPolicy?: Policy,
  rawText?: string,
): Promise<KnowledgeCapsule> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  await assertSchema(SCHEMA_IDS.capsule, value, "Knowledge capsule");
  const capsule = value as KnowledgeCapsule;
  const issues: string[] = [];
  const today = now.toISOString().slice(0, 10);

  if (capsule.checked_at > today) {
    issues.push(`/checked_at ${capsule.checked_at} is in the future`);
  }
  if (capsule.checked_at > capsule.refresh_after) {
    issues.push("/checked_at must not be later than /refresh_after");
  }
  if (capsule.refresh_after < today) {
    issues.push(`/refresh_after ${capsule.refresh_after} has passed`);
  }
  if (capsule.claims.length > policy.capsule_max_claims) {
    issues.push(`/claims exceeds policy limit ${policy.capsule_max_claims}`);
  }
  if (capsule.retrieval_pointers.length > policy.capsule_max_retrieval_pointers) {
    issues.push(`/retrieval_pointers exceeds policy limit ${policy.capsule_max_retrieval_pointers}`);
  }

  addDuplicateIssues(issues, "/sources", capsule.sources.map((source) => source.id));
  addDuplicateIssues(issues, "/claims", capsule.claims.map((claim) => claim.id));
  addDuplicateIssues(issues, "/retrieval_pointers", capsule.retrieval_pointers.map((pointer) => pointer.id));
  const sourceIds = new Set(capsule.sources.map((source) => source.id));
  capsule.claims.forEach((claim, index) => {
    for (const sourceId of claim.source_ids) {
      if (!sourceIds.has(sourceId)) {
        issues.push(`/claims/${index}/source_ids references missing source ${sourceId}`);
      }
    }
  });
  capsule.retrieval_pointers.forEach((pointer, index) => {
    for (const sourceId of pointer.source_ids) {
      if (!sourceIds.has(sourceId)) {
        issues.push(`/retrieval_pointers/${index}/source_ids references missing source ${sourceId}`);
      }
    }
  });

  const allowedSchemes = new Set(policy.allowed_evidence_schemes);
  capsule.sources.forEach((source, index) => {
    const scheme = uriScheme(source.uri);
    if (!allowedSchemes.has(scheme)) {
      issues.push(`/sources/${index}/uri uses disallowed scheme ${scheme}`);
    }
  });
  capsule.retrieval_pointers.forEach((pointer, index) => {
    const scheme = uriScheme(pointer.uri);
    if (!allowedSchemes.has(scheme)) {
      issues.push(`/retrieval_pointers/${index}/uri uses disallowed scheme ${scheme}`);
    }
  });

  for (const [index, source] of capsule.sources.entries()) {
    if (source.local_path === null) {
      if (source.required) {
        issues.push(`/sources/${index}/local_path is required for a required source`);
      }
      continue;
    }
    const sourcePath = isAbsolute(source.local_path)
      ? source.local_path
      : resolve(dirname(filePath), source.local_path);
    try {
      const raw = await readFile(sourcePath);
      if (sha256(raw) !== source.sha256) {
        issues.push(`/sources/${index} digest changed for ${source.local_path}`);
      }
    } catch (error) {
      if (source.required || !(isNodeError(error) && error.code === "ENOENT")) {
        issues.push(`/sources/${index} cannot read ${source.local_path}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new DalError("CAPSULE_INVALID", `Knowledge capsule failed closed: ${filePath}`, issues);
  }
  assertNoSecrets(scanSecrets(capsule, rawText));
  assertNoPii(scanPii(capsule, rawText));
  return capsule;
}

async function capsuleFiles(path: string): Promise<string[]> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw new DalError("CAPSULE_READ_FAILED", `Cannot inspect capsule path: ${path}`);
  }

  if (metadata.isFile()) {
    return path.endsWith(".json") ? [path] : [];
  }
  if (!metadata.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await capsuleFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(child);
    }
  }
  return files;
}

function addDuplicateIssues(issues: string[], path: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(`${path} contains duplicate ID ${value}`);
    }
    seen.add(value);
  }
}

function uriScheme(uri: string): string {
  return uri.slice(0, uri.indexOf("://")).toLowerCase();
}
