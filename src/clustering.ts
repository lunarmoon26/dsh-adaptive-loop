import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DalError } from "./errors.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import { validateRunRecord } from "./runs.js";
import type { ClusterRecord, Policy, RunRecord } from "./types.js";

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
  clusters: ClusterPublishResult[];
}

/**
 * Tier 0/1 deterministic failure clustering. Canonical fingerprints are computed
 * from the structured failure facts at record time; runs are grouped by exact
 * signature. No model, embedding, or classifier is involved. Raw trace text never
 * leaves the run records.
 */
export async function clusterRunRecords(
  options: { store?: string; output?: string; policy?: Policy } = {},
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

  const bySignature = new Map<string, { run: RunRecord; uri: string; digest: string }[]>();
  let skippedSuccessful = 0;
  let skippedUnfailed = 0;

  for (const name of names) {
    const document = await readJsonFile<unknown>(resolve(store, name));
    const run = await validateRunRecord(document.value);
    if (run.outcome === "succeeded") {
      skippedSuccessful += 1;
      continue;
    }
    if (run.failure === null) {
      skippedUnfailed += 1;
      continue;
    }
    const signature = failureSignature(run);
    const members = bySignature.get(signature) ?? [];
    members.push({
      run,
      uri: `repo://.dal/runs/${name}`,
      digest: sha256(document.raw.toString("utf8")),
    });
    bySignature.set(signature, members);
  }

  const clusters: ClusterPublishResult[] = [];
  for (const [signature, entries] of [...bySignature.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sorted = [...entries].sort((left, right) => left.run.run_id.localeCompare(right.run.run_id));
    const { category, code } = sorted[0]!.run.failure!;
    const members = sorted.map(({ run, uri, digest }) => ({
      run_id: run.run_id,
      record_uri: uri,
      sha256: digest,
    }));
    const record: ClusterRecord = {
      $schema: SCHEMA_IDS.clusterRecord,
      schema_version: "1.0.0",
      cluster_id: `clu-${category}-${code}-${signature.slice(0, 12)}`,
      created_at: sorted.map((entry) => entry.run.finished_at).sort().at(-1)!,
      evaluator: "rdl-deterministic-clustering-v1",
      tier: "fingerprint",
      fingerprint: { category, code, signature },
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
    clusters,
  };
}

export function failureSignature(run: RunRecord): string {
  const failure = run.failure;
  if (failure === null) {
    throw new DalError("CLUSTER_INVALID", `Run ${run.run_id} has no failure to fingerprint`);
  }
  return sha256(canonicalJson({ category: failure.category, code: failure.code, extra: failure.fingerprint_extra }));
}
