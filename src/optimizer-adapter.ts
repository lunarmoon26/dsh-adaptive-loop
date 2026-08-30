import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { DalError } from "./errors.js";
import { prettyJson, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { OptimizerCandidate, OptimizerExchange, OptimizerTrainingSet, OptimizerVerdict, RunRecord } from "./types.js";
import { validateOptimizerExchange } from "./optimizer.js";

/**
 * SkillOpt-shaped prepare/evaluate-only adapter.
 *
 * Prepare builds a sanitized training set from stored run records (batch
 * episodes, failure facts, check deltas with goal/actual digests, traces,
 * harness pins) and emits the optimizer-exchange envelope pointing at it.
 * Evaluate runs the deterministic validation gate over a bounded-edits
 * candidate: surface, target, base digest, edit bounds (the "gradient
 * clipping"), anchor checks, and the reconstructed candidate digest.
 *
 * Neither half calls a model, sends data, or applies anything — the reflect
 * step and the rollout remain approval-gated and human-promoted, so this
 * adapter keeps the v0 no-optimizer boundary intact while the exchange,
 * training set, and validation gate all ship and are testable.
 */

export const MAX_EDITS = 8;
export const MAX_EDIT_AFTER_BYTES = 4096;
export const MAX_EPISODES = 64;
export const MAX_TRACE_PER_EPISODE = 32;

export interface PrepareOptions {
  skillPath: string;
  store: string;
  objective?: { goal: string; metrics: string[]; higher_is_better: boolean };
}

export interface PreparedExchange {
  exchange: OptimizerExchange;
  trainingSet: OptimizerTrainingSet;
  exchangePath: string;
  trainingSetPath: string;
}

function exchangeTarget(skillPath: string, skillDigest: string): {
  kind: "skill";
  artifact_uri: string;
  base_sha256: string;
  format: "bounded_edits";
} {
  const rel = relative(process.cwd(), resolve(skillPath)).split(sep).join("/");
  return {
    kind: "skill",
    artifact_uri: `repo://${rel}`,
    base_sha256: skillDigest,
    format: "bounded_edits",
  };
}

async function readRunRecords(store: string): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DalError("OPTIMIZE_STORE_MISSING", `Run store is not readable: ${store}`);
    }
    throw error;
  }
  const records: RunRecord[] = [];
  for (const name of names) {
    const { value } = await readJsonFile<RunRecord>(`${store}/${name}`);
    records.push(value);
  }
  return records;
}

function episodeFrom(record: RunRecord): OptimizerTrainingSet["episodes"][number] {
  return {
    run_id: record.run_id,
    batch_id: record.batch_id ?? null,
    outcome: record.outcome,
    failure:
      record.failure === null
        ? null
        : {
            category: record.failure.category,
            code: record.failure.code,
            summary: record.failure.summary,
          },
    checks: record.checks ?? [],
    trace: (record.trace ?? []).slice(0, MAX_TRACE_PER_EPISODE),
    harness_pins: record.context.harness_pins ?? [],
    metrics: record.metrics,
  };
}

export async function prepareOptimizerExchange(options: PrepareOptions): Promise<PreparedExchange> {
  const skillText = await readFile(options.skillPath, "utf8");
  const skillDigest = sha256(skillText);
  const records = await readRunRecords(resolve(process.cwd(), options.store));
  const ordered = [...records].sort((left, right) => {
    const rank = (record: RunRecord): number => (record.outcome === "failed" ? 0 : 1);
    return rank(left) - rank(right) || left.run_id.localeCompare(right.run_id);
  });
  const episodes = ordered.slice(0, MAX_EPISODES).map(episodeFrom);

  const trainingSetId = `train-${randomUUID().slice(0, 8)}`;
  const exchangeId = `opt-${randomUUID().slice(0, 8)}`;
  const objective = options.objective ?? {
    goal: "Minimize graded task failures without regressing passing tasks",
    metrics: ["task_success_rate", "test_pass_rate", "post_change_regression_rate"],
    higher_is_better: true,
  };

  const trainingSet: OptimizerTrainingSet = {
    $schema: SCHEMA_IDS.optimizerTrainingSet,
    schema_version: "1.0.0",
    training_set_id: trainingSetId,
    created_at: new Date().toISOString(),
    target: exchangeTarget(options.skillPath, skillDigest),
    episodes,
  };
  await assertSchema(SCHEMA_IDS.optimizerTrainingSet, trainingSet, "Optimizer training set");
  assertNoSecrets(scanSecrets(trainingSet));
  assertNoPii(scanPii(trainingSet));

  const exchange: OptimizerExchange = {
    $schema: SCHEMA_IDS.optimizer,
    schema_version: "1.0.0",
    exchange_id: exchangeId,
    mode: "prepare_only",
    provider_hint: "skillopt",
    target: exchangeTarget(options.skillPath, skillDigest),
    objective,
    datasets: {
      train: [`repo://.dal/check/${trainingSetId}.json`],
      validation: [],
      test: [],
    },
    budget: {
      max_evaluations: MAX_EPISODES,
      max_candidates: 8,
      max_wall_time_seconds: 3600,
      max_external_cost_usd: 0,
    },
    privacy: {
      classification: "internal",
      external_transfer_approved: false,
      approval_ref: null,
    },
    result: null,
  };
  await validateOptimizerExchange(exchange);

  const trainingSetPath = resolve(process.cwd(), ".dal", "check", `${trainingSetId}.json`);
  await writeFile(trainingSetPath, prettyJson(trainingSet), { mode: 0o600 });
  return {
    exchange,
    trainingSet,
    exchangePath: ".dal/check/optimizer-exchange.json",
    trainingSetPath: relative(process.cwd(), trainingSetPath),
  };
}

export interface EvaluateOptions {
  exchangePath: string;
  candidatePath: string;
}

export interface EvaluationResult {
  verdict: OptimizerVerdict;
  candidateText: string | null;
}

function check(id: string, pass: boolean, detail: string): OptimizerVerdict["checks"][number] {
  return { id, pass, detail };
}

export async function evaluateOptimizerCandidate(options: EvaluateOptions): Promise<EvaluationResult> {
  const exchange = await validateOptimizerExchange((await readJsonFile<unknown>(options.exchangePath)).value);
  const candidateDocument = await readJsonFile<unknown>(options.candidatePath);
  assertNoSecrets(scanSecrets(candidateDocument.value, candidateDocument.raw.toString("utf8")));
  assertNoPii(scanPii(candidateDocument.value, candidateDocument.raw.toString("utf8")));
  let candidate: OptimizerCandidate;
  try {
    await assertSchema(SCHEMA_IDS.optimizerCandidate, candidateDocument.value, "Optimizer candidate");
    candidate = candidateDocument.value as OptimizerCandidate;
  } catch (error) {
    throw new DalError("OPTIMIZE_CANDIDATE_INVALID", "Candidate does not conform to the optimizer candidate schema", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const checks: OptimizerVerdict["checks"] = [];
  checks.push(
    check(
      "exchange-match",
      candidate.exchange_id === exchange.exchange_id,
      `candidate exchange_id must equal ${exchange.exchange_id}`,
    ),
    check(
      "surface",
      candidate.surface === "skills",
      "the v0 optimizer seam targets only the skills surface",
    ),
    check(
      "target-uri",
      candidate.target_uri === exchange.target.artifact_uri,
      `candidate target_uri must equal ${exchange.target.artifact_uri}`,
    ),
    check(
      "base-digest",
      candidate.base_sha256 === exchange.target.base_sha256,
      "candidate base digest must match the exchange target's current skill digest",
    ),
    check(
      "edit-count",
      candidate.edits.length <= MAX_EDITS,
      `at most ${MAX_EDITS} edits per candidate (gradient clipping)`,
    ),
    check(
      "edit-size",
      candidate.edits.every((edit) => edit.after.length <= MAX_EDIT_AFTER_BYTES),
      `every edit's after text must stay within ${MAX_EDIT_AFTER_BYTES} bytes`,
    ),
  );

  const validImprovements =
    candidate.improvements.length > 0 &&
    candidate.improvements.every((improvement) => exchange.objective.metrics.includes(improvement.metric));
  checks.push(
    check(
      "improvements",
      validImprovements,
      `improvements must name at least one exchange metric from: ${exchange.objective.metrics.join(", ")}`,
    ),
  );

  // Deterministic reconstruction: apply edits sequentially to the exchange's
  // base skill. The exchange target is repo://-relative; resolve from cwd.
  const baseRel = exchange.target.artifact_uri.replace(/^repo:\/\//, "");
  const basePath = resolve(process.cwd(), baseRel);
  let baseText: string;
  try {
    baseText = await readFile(basePath, "utf8");
  } catch {
    checks.push(check("base-readable", false, `exchange target skill is not readable at ${baseRel}`));
    const verdict = await finalizeVerdict(candidate, exchange, checks, null);
    return { verdict, candidateText: null };
  }

  let reconstruction = baseText;
  let lostAnchor: string | null = null;
  for (const edit of candidate.edits) {
    if (!reconstruction.includes(edit.before)) {
      lostAnchor = edit.anchor;
      break;
    }
    reconstruction = reconstruction.replace(edit.before, edit.after);
  }
  checks.push(
    check(
      "anchors",
      lostAnchor === null,
      lostAnchor === null ? "every edit anchor resolves in sequence against the base skill" : `edit anchor lost after sequential application: ${lostAnchor}`,
    ),
  );

  const candidateDigest = lostAnchor === null ? sha256(reconstruction) : null;
  checks.push(
    check("changed", candidateDigest !== null && candidateDigest !== exchange.target.base_sha256, "the candidate must change the base skill"),
  );

  const verdict = await finalizeVerdict(candidate, exchange, checks, lostAnchor === null ? candidateDigest : null);
  return { verdict, candidateText: lostAnchor === null ? reconstruction : null };
}

async function finalizeVerdict(
  candidate: OptimizerCandidate,
  exchange: OptimizerExchange,
  checks: OptimizerVerdict["checks"],
  candidateSha256: string | null,
): Promise<OptimizerVerdict> {
  const verdict: OptimizerVerdict = {
    $schema: SCHEMA_IDS.optimizerVerdict,
    schema_version: "1.0.0",
    verdict_id: `vrd-${randomUUID().slice(0, 8)}`,
    candidate_id: candidate.candidate_id,
    exchange_id: exchange.exchange_id,
    verdict: checks.every((entry) => entry.pass) ? "valid" : "invalid",
    checks,
    candidate_sha256: candidateSha256,
    base_sha256: exchange.target.base_sha256,
    created_at: new Date().toISOString(),
  };
  await assertSchema(SCHEMA_IDS.optimizerVerdict, verdict, "Optimizer verdict");
  assertNoSecrets(scanSecrets(verdict));
  assertNoPii(scanPii(verdict));
  return verdict;
}
