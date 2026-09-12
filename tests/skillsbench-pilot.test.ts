import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outputInventory, parsePilotArgs, pilotContainerArgs, verifierPass } from "../benchmarks/skillsbench-pilot/run.js";
import { createRehearsalUpstream, GATEWAY_ROUTES } from "../src/e2e-model-gateway.js";
import { sha256 } from "../src/json.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "dal-sb-test-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("keyless SkillsBench pilot", () => {
  it("accepts passing tests and ordinary assertion failures, never setup errors or skipped tests", () => {
    const xml = (failures: number, errors = 0, skipped = 0, tests = 3) => `<testsuites><testsuite tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}"></testsuite></testsuites>`;
    expect(verifierPass(0, xml(0))).toBe(true);
    expect(verifierPass(1, xml(3))).toBe(false);
    for (const [code, body] of [[1, xml(0, 3)], [0, xml(0, 0, 1)], [0, xml(0, 0, 0, 0)], [2, xml(0)], [1, xml(0)], [0, xml(3)], [1, ""], [1, xml(4)]] as const) expect(() => verifierPass(code, body)).toThrow();
  });
  it.each([["live"], ["rehearse", "--mode", "live"], ["qualify", "--provider", "openai"], ["rehearse", "--approval", "decision.json"], ["fetch", "--url", "https://example.com"], ["build", "--image", "other"]])("rejects unauthorized execution or configuration %j", (...args) => {
    expect(() => parsePilotArgs(args)).toThrow();
  });
  it("accepts only fixed actions and an explicit rehearsal skill", () => {
    expect(parsePilotArgs(["qualify"])).toEqual({ action: "qualify", skill: undefined });
    expect(parsePilotArgs(["rehearse", "--skill", ".dal/candidates/one.md"]).skill).toBe(".dal/candidates/one.md");
  });
  it("confines a producer to its data and output with no oracle, repository, keys or outbound network", () => {
    const args = pilotContainerArgs(`sha256:${"a".repeat(64)}`, "test", "/private/output", "/private/data");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("type=bind,src=/private/data,dst=/root/data,readonly");
    expect(args).toContain("type=bind,src=/private/output,dst=/root/output");
    for (const forbidden of ["/verifier", "/oracle", "/workspace", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "docker.sock", "--privileged"]) expect(args.join(" ")).not.toContain(forbidden);
    expect(() => pilotContainerArgs("mutable:tag", "test", "/o", "/d")).toThrow();
    expect(() => pilotContainerArgs(`sha256:${"a".repeat(64)}`, "test", "/o,readonly=false", "/d")).toThrow();
  });
  it("hashes actual output bytes and accepts an empty no-op tree", async () => {
    expect(await outputInventory(root)).toEqual([]);
    await writeFile(join(root, "model.obj"), "v 1 2 3\n");
    expect(await outputInventory(root)).toEqual([{ path: "model.obj", sha256: sha256("v 1 2 3\n"), bytes: 8 }]);
  });
  it.each(["symlink", "hardlink", "oversize", "directory-link"])("rejects unsafe output %s", async kind => {
    const path = join(root, "object.obj"); await writeFile(path, "v 1 2 3\n");
    if (kind === "symlink") await symlink(path, join(root, "alias.obj"));
    if (kind === "hardlink") await link(path, join(root, "alias.obj"));
    if (kind === "oversize") await truncate(path, 32 * 1024 * 1024 + 1);
    if (kind === "directory-link") { await mkdir(join(root, "dir")); await symlink(join(root, "dir"), join(root, "alias")); }
    await expect(outputInventory(root)).rejects.toThrow();
  });
  it.each(["openai", "anthropic"] as const)("rehearses the fixed shell probe for %s, never arbitrary caller commands", async provider => {
    const fixture = createRehearsalUpstream();
    const response = await fixture(GATEWAY_ROUTES[provider], { body: JSON.stringify({ model: "fixture", tools: [{ name: "bash" }], stream: false }) });
    const body = await response.json();
    const tool = provider === "openai" ? body.output[1] : body.content[0];
    expect(tool.name).toBe("bash");
    const args = provider === "openai" ? JSON.parse(tool.arguments) : tool.input;
    expect(args.command).toContain("pilot-shell-ok");
    expect(args.command).toContain("sha256sum /root/.agents/skills/obj-exporter/SKILL.md");
    expect(args.description).toBeTruthy();
  });
  it("preserves the existing workflow fixture when get_order is available", async () => {
    const response = await createRehearsalUpstream()(GATEWAY_ROUTES.openai, { body: JSON.stringify({ tools: [{ name: "bash" }, { name: "get_order" }] }) });
    expect((await response.json()).output[1].name).toBe("get_order");
  });
});
