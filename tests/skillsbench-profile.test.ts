import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogEvidence, inspectPilotCatalog, LEAN_TOOLS, pilotCompositionPatch, pilotProfile } from "../benchmarks/skillsbench-pilot/profile.js";
import { parsePilotArgs } from "../benchmarks/skillsbench-pilot/run.js";
import { contextDigest, parseLiveArgs } from "../benchmarks/skillsbench-pilot/live.js";
import { buildGatewayCompositionPatch, buildToolsRow } from "../benchmarks/tau-style-workflow/e2e-prompt.js";
import { canonicalJson, sha256 } from "../src/json.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "dal-lean-profile-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const header = (names: readonly string[] = LEAN_TOOLS) => JSON.stringify({ type: "request/header", data: { header: { system: "Pilot instructions", tools: names.map(name => ({ name, parameters: {} })) } } });

describe("pilot-local lean composition", () => {
  it("preserves the standard patch bytes and defaults", () => {
    expect(pilotProfile()).toBe("standard");
    expect(pilotCompositionPatch("standard")).toBe(buildGatewayCompositionPatch("openai", "gpt-5.6-terra", "unused").replace(buildToolsRow("unused"), ""));
  });
  it("removes overhead providers without changing security, model or skill services", () => {
    const standard = pilotCompositionPatch("standard"); const lean = pilotCompositionPatch("lean");
    expect(lean.startsWith(standard)).toBe(true);
    const overlay = lean.slice(standard.length);
    for (const id of ["tool-goal", "tool-todo", "tool-subagent", "tool-workflow", "tool-web", "tool-jobs", "plan-mode", "tool-ralph", "tool-str-replace-editor"]) expect(overlay).toContain(`- id: ${id}\n  disabled: true\n`);
    for (const id of ["permission", "approval", "sandbox", "sandbox-policy", "fs-sandbox", "session-persistence-jsonl", "llm-pi-ai", "tool-fs", "tool-skill"]) expect(overlay).not.toContain(`- id: ${id}\n`);
    expect(overlay).toContain("enableRunInBackground: false");
  });
  it("binds the profile patch into approval and comparison identities", () => {
    const context = { task: "threejs-to-obj", image: "sha256:" + "a".repeat(64), provenance: {}, drivers: [], upstream_commit: "a".repeat(40), source_lock: [],
      prompt: "Export the object", provider: "openai", model: "gpt-5.6-terra", timeout_ms: 360000, cpus: 1, memory_mb: 4096,
      network: "candidate-internal-gateway-only", cumulative_cap_microusd: 12123852, campaign: "test" };
    const standard = { ...context, patch: pilotCompositionPatch("standard") };
    const lean = { ...context, patch: pilotCompositionPatch("lean") };
    expect(sha256(canonicalJson(lean))).not.toBe(sha256(canonicalJson(standard)));
    expect(contextDigest(lean)).not.toBe(contextDigest(standard));
  });
  it("accepts the explicit profile in both rehearsal and live parsers", () => {
    expect(parsePilotArgs(["rehearse", "--skill", "candidate.md", "--harness-profile", "lean"]).harnessProfile).toBe("lean");
    expect(parsePilotArgs(["rehearse", "--harness-profile", "lean", "--skill", "candidate.md"]).skill).toBe("candidate.md");
    expect(parseLiveArgs(["prepare", "--harness-profile", "lean"]).args.get("harness-profile")).toBe("lean");
  });
  it.each(["other", "", "../lean", "LEAN"])("rejects unknown profile %j", value => {
    expect(() => pilotProfile(value)).toThrow();
    expect(() => parseLiveArgs(["run", "--harness-profile", value])).toThrow();
  });
  it("rejects duplicate options and profile flags on non-agent commands", () => {
    expect(() => parsePilotArgs(["rehearse", "--harness-profile", "lean", "--harness-profile", "standard"])).toThrow();
    expect(() => parsePilotArgs(["qualify", "--harness-profile", "lean"])).toThrow();
    expect(() => parseLiveArgs(["assess", "--harness-profile", "lean"])).toThrow();
  });
  it("checks the actual catalog and reports native serialized header sizes", () => {
    const evidence = catalogEvidence(header(), "lean");
    expect(evidence[0]!.tools).toEqual(LEAN_TOOLS);
    expect(evidence[0]!.tool_schema_bytes).toBe(Buffer.byteLength(JSON.stringify(LEAN_TOOLS.map(name => ({ name, parameters: {} })))));
    expect(evidence[0]!.header_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([ [...LEAN_TOOLS, "todo_write"], LEAN_TOOLS.slice(1), [...LEAN_TOOLS, "bash"] ])("rejects added, omitted or duplicate tools %j", (...names) => {
    expect(() => catalogEvidence(header(names), "lean")).toThrow("catalog");
  });
  it("checks every request header, including later changed catalogs", () => {
    expect(() => catalogEvidence(`${header()}\n${header([...LEAN_TOOLS, "create_goal"])}`, "lean")).toThrow("catalog");
    expect(() => catalogEvidence("", "lean")).toThrow("Missing");
  });
  it("reads the fresh native session and rejects missing or linked logs", async () => {
    const dir = join(root, "sessions/project/session"); await mkdir(dir, { recursive: true });
    await expect(inspectPilotCatalog(root, "lean")).rejects.toThrow("one fresh");
    await writeFile(join(dir, "session.jsonl"), header());
    expect((await inspectPilotCatalog(root, "lean")).headers[0]!.tools).toEqual(LEAN_TOOLS);
    await symlink(join(dir, "session.jsonl"), join(dir, "session.jsonl.zstd"));
    await expect(inspectPilotCatalog(root, "lean")).rejects.toThrow("one fresh");
  });
});
