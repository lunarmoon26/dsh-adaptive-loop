import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendCampaignOperation, artifactCampaignStatus } from "../src/artifact-campaign.js";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/json.js";
import { checkResearchMechanism, prepareResearchRequest, stageResearchMechanism, validateResearchMechanism, verifyResearchRequest } from "../src/research.js";
import { digest, researchWorkflow, writeJson } from "./fixtures/research/workflow.js";

describe("research mechanism foundation", () => {
  let cwd: string;
  let directory: string;
  let fixture: Awaited<ReturnType<typeof researchWorkflow>>;
  const requestPath = () => join(directory, ".dal/research/requests", fixture.plan.campaign_id, `${fixture.reservation.node_id}.json`);
  const prepare = () => prepareResearchRequest("binding.json");
  const saveBinding = () => writeJson("binding.json", fixture.binding);
  beforeEach(async () => {
    cwd = process.cwd();
    directory = await mkdtemp("/tmp/opencode/research-test-");
    process.chdir(directory);
    fixture = await researchWorkflow(directory);
  });
  afterEach(async () => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("uses canonical whole-document identity independent of key order and stages privately without activation", async () => {
    const { mechanism } = fixture;
    const reversed = Object.fromEntries(Object.entries(mechanism).reverse());
    await writeJson("reordered.json", reversed);
    expect(await checkResearchMechanism("reordered.json")).toEqual(await checkResearchMechanism("mechanism.json"));
    expect((await checkResearchMechanism("mechanism.json")).mechanism_sha256).toBe(digest(mechanism));
    expect(await stageResearchMechanism("mechanism.json")).toMatchObject({ status: "staged" });
    expect(await stageResearchMechanism("reordered.json")).toMatchObject({ status: "idempotent" });
    const path = join(directory, ".dal/research/mechanisms", `${digest(mechanism)}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, ".dal/research"))).toEqual(["mechanisms"]);
  });

  it("requires the staged parent even when the child destination already exists", async () => {
    await stageResearchMechanism("mechanism.json");
    const child = { ...fixture.mechanism, parent_sha256: digest(fixture.mechanism) };
    await writeJson("child.json", child);
    await stageResearchMechanism("child.json");
    await unlink(join(directory, ".dal/research/mechanisms", `${child.parent_sha256}.json`));
    await expect(stageResearchMechanism("child.json")).rejects.toThrow();
  });

  it.each(["permissions", "maximum_budget", "evaluator", "audit_log", "rollback_mechanism"])("rejects protected unknown field %s", async key => {
    await expect(validateResearchMechanism({ ...fixture.mechanism, [key]: {} })).rejects.toThrow();
  });
  it.each(["instructions", "search_policy", "experience_policy"] as const)("closes nested %s fields", async key => {
    await expect(validateResearchMechanism({ ...fixture.mechanism, [key]: { ...fixture.mechanism[key], permissions: [] } })).rejects.toThrow();
  });
  it.each([" \n\t", "é".repeat(10001)])("rejects blank or byte-oversized instructions", async diagnosis => {
    await expect(validateResearchMechanism({ ...fixture.mechanism, instructions: { ...fixture.mechanism.instructions, diagnosis } }))
      .rejects.toMatchObject({ code: "RESEARCH_INSTRUCTION_LIMIT" });
  });
  it("rejects synthetic secrets and duplicate JSON keys before staging", async () => {
    await writeJson("secret.json", { ...fixture.mechanism, instructions: { ...fixture.mechanism.instructions, diagnosis: "-----BEGIN PRIVATE KEY-----" } });
    await expect(stageResearchMechanism("secret.json")).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    await writeFile("duplicate.json", JSON.stringify(fixture.mechanism).replace('"parent_sha256":null', '"parent_sha256":null,"parent_sha256":null'));
    await expect(checkResearchMechanism("duplicate.json")).rejects.toMatchObject({ code: "INVALID_IJSON_VALUE" });
  });

  it("prepares accepted exact inputs including a binary cache without extra allocation or raw ledger payload", async () => {
    await fixture.seed();
    const before = await artifactCampaignStatus(fixture.plan.campaign_id);
    expect(await prepare()).toMatchObject({ status: "prepared" });
    expect(await prepare()).toMatchObject({ status: "idempotent" });
    const request = await verifyResearchRequest(requestPath());
    expect(request).toMatchObject({ mechanism_sha256: digest(fixture.mechanism), worker_id: fixture.reservation.worker_id,
      task_contract_sha256: fixture.reservation.contract_sha256, resources: fixture.reservation.reservation,
      ledger: { sequence: before.sequence, head_sha256: before.head_sha256 } });
    expect(request.instructions).toContain(fixture.mechanism.instructions.diagnosis);
    expect((await stat(requestPath())).mode & 0o777).toBe(0o600);
    expect(await artifactCampaignStatus(fixture.plan.campaign_id)).toEqual(before);
    const store = join(directory, ".dal/artifact-campaigns", fixture.plan.campaign_id);
    const ledger = await readFile(join(store, "events/000001.json"), "utf8");
    for (const payload of [fixture.mechanism.instructions.diagnosis, request.instructions, JSON.stringify(request.task_contract)]) expect(ledger).not.toContain(payload);
  });

  it.each(["missing", "extra", "duplicate"])("rejects %s input bindings", async mode => {
    await fixture.seed();
    if (mode === "missing") fixture.binding.artifacts.pop();
    if (mode === "extra") fixture.binding.artifacts.push({ sha256: "a".repeat(64), uri: "repo://inputs/cache.bin" });
    if (mode === "duplicate") fixture.binding.artifacts[2] = { ...fixture.binding.artifacts[0]! };
    await saveBinding();
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_INPUT_SET_MISMATCH" });
  });
  it.each(["researcher_sha256", "policy_sha256"] as const)("rejects plan %s mismatch", async field => {
    fixture.plan[field] = "a".repeat(64);
    await fixture.seed();
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_PLAN_MECHANISM_MISMATCH" });
  });
  it.each(["wrong-kind", "unreserved"])("rejects %s task harness", async mode => {
    if (mode === "wrong-kind") {
      fixture.plan.root_artifacts[1]!.kind = "feature-cache";
      fixture.reservation.inputs[1]!.kind = "feature-cache";
    } else fixture.binding.task_harness_sha256 = "a".repeat(64);
    await fixture.seed();
    await saveBinding();
    await expect(prepare()).rejects.toMatchObject({ code: mode === "wrong-kind" ? "RESEARCH_HARNESS_KIND" : "RESEARCH_HARNESS_NOT_RESERVED" });
  });
  it.each(["task.json", "harness.txt", "workspace.txt"])("rejects %s byte drift at preparation and verification", async file => {
    await fixture.seed();
    await prepare();
    await writeFile(join("inputs", file), file === "task.json" ? '{"changed":true}' : "Changed synthetic bytes.");
    const code = file === "task.json" ? "RESEARCH_TASK_CONTRACT_DRIFT" : "RESEARCH_ARTIFACT_DRIFT";
    await expect(prepare()).rejects.toMatchObject({ code });
    await expect(verifyResearchRequest(requestPath())).rejects.toMatchObject({ code });
  });
  it.each(["symlink", "parent-symlink", "escape"])("rejects %s input traversal", async mode => {
    await fixture.seed();
    if (mode === "symlink") {
      await symlink(join(directory, "inputs/workspace.txt"), "alias.txt");
      fixture.binding.artifacts[0]!.uri = "repo://alias.txt";
    } else if (mode === "parent-symlink") {
      await symlink(join(directory, "inputs"), "alias");
      fixture.binding.artifacts[0]!.uri = "repo://alias/workspace.txt";
    } else fixture.binding.artifacts[0]!.uri = "repo://../outside.txt";
    await saveBinding();
    await expect(prepare()).rejects.toThrow();
  });
  it("rejects conflicting binding paths without overwriting the immutable request", async () => {
    await fixture.seed();
    await prepare();
    const previous = await readFile(requestPath());
    await writeFile("inputs/alias.txt", await readFile("inputs/workspace.txt"));
    fixture.binding.artifacts[0]!.uri = "repo://inputs/alias.txt";
    await saveBinding();
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_REQUEST_CONFLICT" });
    expect(await readFile(requestPath())).toEqual(previous);
  });
  it("does not verify an unpublished alternative binding as a prepared request", async () => {
    await fixture.seed();
    await prepare();
    const alternative = JSON.parse(await readFile(requestPath(), "utf8"));
    await writeFile("inputs/alias.txt", await readFile("inputs/workspace.txt"));
    alternative.binding.artifacts[0].uri = "repo://inputs/alias.txt";
    await writeJson("alternative.json", alternative);
    await expect(verifyResearchRequest("alternative.json")).rejects.toMatchObject({ code: "RESEARCH_REQUEST_NOT_PREPARED" });
  });
  it("rejects JSON-escaped request expansion before publishing an unreadable request", async () => {
    fixture.mechanism.instructions = { diagnosis: "D" + "\0".repeat(19999), proposal: "P" + "\0".repeat(19999) };
    await writeJson("mechanism.json", fixture.mechanism);
    fixture.plan.researcher_sha256 = digest(fixture.mechanism);
    fixture.binding.mechanism_sha256 = fixture.plan.researcher_sha256;
    const harness = "H" + "\0".repeat(65535);
    await writeFile("inputs/harness.txt", harness);
    const id = sha256(harness);
    Object.assign(fixture.plan.root_artifacts[1]!, { sha256: id, locator: `artifact://${id}` });
    fixture.reservation.inputs[1]!.sha256 = id;
    fixture.binding.artifacts[1]!.sha256 = id;
    fixture.binding.task_harness_sha256 = id;
    await saveBinding();
    await fixture.seed();
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_REQUEST_LIMIT" });
    await expect(stat(requestPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects changed current ledger head even when the reservation remains pending", async () => {
    await fixture.seed();
    await prepare();
    await appendCampaignOperation({ ...fixture.reservation, operation_id: "reserve-sibling", node_id: "sibling" });
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_REQUEST_CONFLICT" });
    await expect(verifyResearchRequest(requestPath())).rejects.toMatchObject({ code: "RESEARCH_REQUEST_DRIFT" });
  });
  it.each(["unknown", "completed"] as const)("refuses preparation after %s result", async outcome => {
    await fixture.seed();
    await appendCampaignOperation({ ...fixture.result, outcome });
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_RESERVATION_NOT_PENDING" });
  });
  it("refuses pending work after a sibling reports an overrun", async () => {
    await fixture.seed();
    await appendCampaignOperation({ ...fixture.reservation, operation_id: "reserve-sibling", node_id: "sibling" });
    await appendCampaignOperation({ ...fixture.result, operation_id: "result-sibling", node_id: "sibling", usage: { compute_seconds: 101 } });
    await expect(prepare()).rejects.toMatchObject({ code: "RESEARCH_RESERVATION_NOT_PENDING" });
  });
  it.each(["instructions", "worker_id", "resources", "task_contract", "ledger", "reservation_sha256"])("verifies against tampered prepared %s", async field => {
    await fixture.seed();
    await prepare();
    const request = JSON.parse(await readFile(requestPath(), "utf8"));
    const replacements: Record<string, unknown> = { instructions: "Changed synthetic instructions.", worker_id: "different-worker", resources: { compute_seconds: 99 },
      task_contract: { changed: true }, ledger: { ...request.ledger, head_sha256: "a".repeat(64) }, reservation_sha256: "a".repeat(64) };
    request[field] = replacements[field];
    await writeJson(requestPath(), request);
    await expect(verifyResearchRequest(requestPath())).rejects.toMatchObject({ code: "RESEARCH_REQUEST_DRIFT" });
  });
  it("CLI check, stage, prepare and verify print metadata only", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    for (const action of ["check", "stage"]) expect(await runCli(["research", "mechanism", action, "--file", "mechanism.json"], io)).toBe(0);
    await fixture.seed();
    expect(await runCli(["research", "prepare", "--binding", "binding.json"], io)).toBe(0);
    expect(await runCli(["research", "verify", "--file", requestPath()], io)).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(4);
    for (const line of output) {
      const metadata = JSON.parse(line);
      expect(metadata.mechanism_sha256).toBe(digest(fixture.mechanism));
      expect(metadata).not.toHaveProperty("instructions");
      expect(metadata).not.toHaveProperty("task_contract");
      expect(line).not.toContain(fixture.mechanism.instructions.diagnosis);
      expect(line).not.toContain("synthetic-research-task");
    }
  });
});
