import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "./errors.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import { validateRunRecord } from "./runs.js";
import type { ClusterRecord, Policy, RunFailureCategory, RunRecord } from "./types.js";

export interface ClusterPublishResult {
  cluster_id: string;
  member_count: number;
  path: string;
  status: "stored" | "idempotent";
}

export interface ClusterRunResult {
  cluster_count: number;
  clustered_runs: number;
  skipped_successful_runs: number;
  skipped_unfailed_runs: number;
  clustered_harness_failures: number;
  clustered_business_failures: number;
  clusters: ClusterPublishResult[];
}

interface ClusterFacts {
  category: RunFailureCategory | "business_failure";
  code: string;
  extra: string[];
  summary: string;
}

interface ClusterEntry {
  run: RunRecord;
  uri: string;
  digest: string;
  facts: ClusterFacts;
}

/**
 * Tier 0/1 deterministic failure clustering. Canonical fingerprints are computed
 * from the structured failure facts at record time; runs are grouped by exact
 * signature. No model, embedding, or classifier is involved. Raw trace text never
 * leaves the run records.
 */
export async function clusterRunRecords(
  options: { store?: string; output?: string; policy?: Policy; batch?: string } = {},
): Promise<ClusterRunResult> {
  const policy = options.policy ?? (await loadPolicy());
  const store = resolve(process.cwd(), options.store ?? policy.default_run_store);
  const output = resolve(process.cwd(), options.output ?? policy.default_cluster_store);

  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new DalError("CLUSTER_STORE_MISSING", `Run store is not readable: ${store}`);
  }

  const bySignature = new Map<string, ClusterEntry[]>();
  const requestedBatch = options.batch ?? null;
  let skippedSuccessful = 0;
  let skippedUnfailed = 0;
  let clusteredHarnessFailures = 0;
  let clusteredBusinessFailures = 0;

  for (const name of names) {
    const document = await readJsonFile<unknown>(resolve(store, name));
    const run = await validateRunRecord(document.value);
    if (requestedBatch !== null && (run.batch_id ?? null) !== requestedBatch) {
      continue;
    }
    const facts = clusterFacts(run);
    if (facts === null) {
      if (run.outcome === "succeeded") {
        skippedSuccessful += 1;
      } else {
        skippedUnfailed += 1;
      }
      continue;
    }
    if (facts.category === "business_failure") {
      clusteredBusinessFailures += 1;
    } else {
      clusteredHarnessFailures += 1;
    }
    const batch = run.batch_id ?? "unbatched";
    const signature = `${sha256(canonicalJson({ category: facts.category, code: facts.code, extra: facts.extra }))}|batch=${batch}`;
    const members = bySignature.get(signature) ?? [];
    members.push({
      run,
      uri: `repo://.dal/runs/${name}`,
      digest: sha256(document.raw.toString("utf8")),
      facts,
    });
    bySignature.set(signature, members);
  }

  const clusters: ClusterPublishResult[] = [];
  for (const [signature, entries] of [...bySignature.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sorted = [...entries].sort((left, right) => left.run.run_id.localeCompare(right.run.run_id));
    const { category, code } = sorted[0]!.facts;
    const members = sorted.map(({ run, uri, digest }) => ({
      run_id: run.run_id,
      record_uri: uri,
      sha256: digest,
    }));
    const fingerprint = signature.slice(0, signature.indexOf("|batch="));
    const batchId = signature.slice(signature.indexOf("|batch=") + "|batch=".length);
    const record: ClusterRecord = {
      $schema: SCHEMA_IDS.clusterRecord,
      schema_version: "1.0.0",
      cluster_id: `clu-${category}-${code}-${fingerprint.slice(0, 12)}-${sha256(batchId).slice(0, 8)}`,
      batch_id: batchId,
      created_at: sorted.map((entry) => entry.run.finished_at).sort().at(-1)!,
      evaluator: "rdl-deterministic-clustering-v1",
      tier: "fingerprint",
      fingerprint: { category, code, signature: fingerprint },
      members,
      representative: members[0]!,
      member_count: members.length,
      summary: `Deterministic ${category}/${code} failure cluster with ${members.length} member runs`,
    };
    await assertSchema(SCHEMA_IDS.clusterRecord, record, "Cluster record");

    const destination = resolve(output, `${record.cluster_id}.json`);
    const published = await publishJsonExclusive(destination, record);
    if (!published) {
      const existing = await readJsonFile<ClusterRecord>(destination);
      if (sha256(canonicalJson(existing.value)) === sha256(canonicalJson(record))) {
        clusters.push({ cluster_id: record.cluster_id, member_count: members.length, path: destination, status: "idempotent" });
        continue;
      }
      throw new DalError("CLUSTER_ID_CONFLICT", `Cluster ${record.cluster_id} already exists with different members`);
    }
    clusters.push({ cluster_id: record.cluster_id, member_count: members.length, path: destination, status: "stored" });
  }

  return {
    cluster_count: clusters.length,
    clustered_runs: clusters.reduce((total, cluster) => total + cluster.member_count, 0),
    skipped_successful_runs: skippedSuccessful,
    skipped_unfailed_runs: skippedUnfailed,
    clustered_harness_failures: clusteredHarnessFailures,
    clustered_business_failures: clusteredBusinessFailures,
    clusters,
  };
}

function clusterFacts(run: RunRecord): ClusterFacts | null {
  if (run.outcome === "failed" && run.failure !== null) {
    return {
      category: run.failure.category,
      code: run.failure.code,
      extra: run.failure.fingerprint_extra,
      summary: run.failure.summary,
    };
  }
  if (run.outcome !== "succeeded" || run.business_outcome?.status !== "failed") {
    return null;
  }
  const failedChecks = (run.checks ?? [])
    .filter((check) => !check.pass)
    .map((check) => check.id)
    .sort();
  const first = failedChecks[0] ?? "business-outcome";
  return {
    category: "business_failure",
    code: identifier(first),
    extra: failedChecks,
    summary: `Business grader failed ${failedChecks.length} checks`,
  };
}

function identifier(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 128);
  return normalized === "" ? "business-outcome-failed" : normalized;
}

export function failureSignature(run: RunRecord): string {
  const failure = run.failure;
  if (failure === null) {
    throw new DalError("CLUSTER_INVALID", `Run ${run.run_id} has no failure to fingerprint`);
  }
  return sha256(canonicalJson({ category: failure.category, code: failure.code, extra: failure.fingerprint_extra }));
}
