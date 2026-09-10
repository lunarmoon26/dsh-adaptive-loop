import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sha256 } from "../src/json.js";
import { prepareChatRequest } from "../src/propose-transport.js";
import { prepareSkillProposal, validateSkillProposalReply } from "../src/skill-proposal.js";
import { SCHEMA_IDS } from "../src/schema.js";
import type { OptimizerExchange } from "../src/types.js";

let root: string;
let exchange: OptimizerExchange;
let exchangePath: string;
let basePath: string;
const base = "# Skill\nCheck refund status.\n";
const summaries = { task: "propose_one_falsifiable_change" as const, editable_surfaces: ["skills"] as const,
  clusters: [{ cluster_id: "clu-development", category: "business", code: "failed-check", member_count: 1, representative_failure: "Recovery check failed." }], output_contract: "draft" };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dal-skill-proposal-")));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  basePath = join(root, ".agents/skills/refund/SKILL.md");
  await mkdir(join(root, ".agents/skills/refund"), { recursive: true });
  await writeFile(basePath, base);
  exchangePath = join(root, "exchange.json");
  exchange = { $schema: SCHEMA_IDS.optimizer, schema_version: "1.0.0", exchange_id: "opt-test-skill", mode: "prepare_only", provider_hint: "skillopt",
    target: { kind: "skill", artifact_uri: "repo://.agents/skills/refund/SKILL.md", base_sha256: sha256(base), format: "bounded_edits" },
    objective: { goal: "Improve recovery", metrics: ["task_success_rate"], higher_is_better: true },
    datasets: { train: ["repo://dataset-must-not-read.json"], validation: ["repo://evaluator-must-not-read.json"], test: ["repo://holdout-must-not-read.json"] },
    budget: { max_evaluations: 1, max_candidates: 1, max_wall_time_seconds: 30, max_external_cost_usd: 0 },
    privacy: { classification: "internal", external_transfer_approved: false, approval_ref: null }, result: null };
  await writeFile(exchangePath, JSON.stringify(exchange));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("projects only skill text and development summaries, with exact source byte hashes", async () => {
  const prepared = await prepareSkillProposal(root, exchangePath, summaries);
  expect(prepared.payload).toMatchObject({ task: summaries.task, output_kind: "optimizer_candidate", clusters: summaries.clusters,
    editable_surfaces: ["skills"], skill_target: { base_text: base, base_sha256: sha256(Buffer.from(base)), exchange_id: exchange.exchange_id } });
  expect(prepared.inputs.exchange.sha256).toBe(sha256(await readFile(exchangePath)));
  expect(prepared.payload).not.toHaveProperty("datasets");
  for (const name of ["dataset-must-not-read", "evaluator-must-not-read", "holdout-must-not-read", "max_external_cost_usd"]) expect(prepared.json).not.toContain(name);
});

it.each(["drift", "symlink", "ancestor-symlink", "traversal", "escaped", "absolute", "fixture", "wrong-kind", "wrong-format", "invalid-utf8", "privacy", "too-large", "cwd"])("rejects unsafe base before preparing an external request: %s", async kind => {
  if (kind === "drift") await writeFile(basePath, base + "drift");
  if (kind === "symlink") { await rm(basePath); await symlink(exchangePath, basePath); }
  if (kind === "ancestor-symlink") { await mkdir(join(root, "linked")); await symlink(join(root, ".agents"), join(root, "linked/.agents")); exchange.target.artifact_uri = "repo://linked/.agents/skills/refund/SKILL.md"; }
  if (kind === "traversal") exchange.target.artifact_uri = "repo://../.agents/skills/refund/SKILL.md";
  if (kind === "escaped") exchange.target.artifact_uri = "repo://%2e%2e/.agents/skills/refund/SKILL.md";
  if (kind === "absolute") exchange.target.artifact_uri = `file://${basePath}`;
  if (kind === "fixture") exchange.target.artifact_uri = "repo://tests/holdout.md";
  if (kind === "wrong-kind") exchange.target.kind = "prompt";
  if (kind === "wrong-format") exchange.target.format = "complete_text";
  if (["invalid-utf8", "privacy", "too-large"].includes(kind)) {
    const bytes = kind === "invalid-utf8" ? Buffer.from([0xff]) : Buffer.from(kind === "privacy" ? "ghp_1234567890abcdefghij" : "x".repeat(65537));
    await writeFile(basePath, bytes); exchange.target.base_sha256 = sha256(bytes);
  }
  if (kind === "cwd") vi.mocked(process.cwd).mockReturnValue(join(root, "other"));
  await writeFile(exchangePath, JSON.stringify(exchange));
  await expect(prepareSkillProposal(root, exchangePath, summaries)).rejects.toThrow();
});

it("keeps the existing 64 KiB request bound after adding skill source", async () => {
  const text = "x".repeat(63000);
  await writeFile(basePath, text); exchange.target.base_sha256 = sha256(text);
  await writeFile(exchangePath, JSON.stringify(exchange));
  const { payload } = await prepareSkillProposal(root, exchangePath, summaries);
  expect(() => prepareChatRequest(payload, { provider: "openai", model: "gpt-5.6-terra" },
    { budget_id: "test-skill", provider_limit_microusd: 1000000, reservation_microusd: 1 })).toThrow("byte limit");
});

it.each(["valid", "malformed", "exchange", "base", "target", "surface", "model", "secret", "oversize", "unicode-bytes"])("validates native candidate JSON without relabeling: %s", async kind => {
  const { payload } = await prepareSkillProposal(root, exchangePath, summaries);
  const candidate = { $schema: SCHEMA_IDS.optimizerCandidate, schema_version: "1.0.0", candidate_id: "cand-test-skill", exchange_id: exchange.exchange_id,
    surface: "skills", target_uri: exchange.target.artifact_uri, base_sha256: exchange.target.base_sha256,
    title: "Recover safely", objective: "Improve recovery", statement: "Recovery task success increases.",
    improvements: [{ metric: "task_success_rate", expected_delta: 0.1 }], regressions: [],
    edits: [{ anchor: "status", before: "Check refund status.", after: "Check refund status before retrying." }] };
  if (kind === "exchange") candidate.exchange_id = "opt-other";
  if (kind === "base") candidate.base_sha256 = "0".repeat(64);
  if (kind === "target") candidate.target_uri = "repo://other.md";
  if (kind === "surface") candidate.surface = "prompt";
  if (kind === "model") Object.assign(candidate, { model: "model-assertion" });
  if (kind === "secret") candidate.title = "ghp_1234567890abcdefghij";
  if (kind === "oversize") candidate.edits[0]!.after = "x".repeat(4097);
  if (kind === "unicode-bytes") candidate.edits[0]!.after = "\u20ac".repeat(2000);
  const result = validateSkillProposalReply(kind === "malformed" ? "not json" : JSON.stringify(candidate), payload.skill_target);
  if (kind === "valid") await expect(result).resolves.toEqual(candidate);
  else await expect(result).rejects.toThrow();
});
