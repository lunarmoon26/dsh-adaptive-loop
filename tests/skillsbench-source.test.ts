import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedUtf8, fetchPilotSources, PILOT_CACHE, PILOT_COMMIT, PILOT_SOURCE_LOCK, pilotDockerBuildArgs, pilotQualificationCommand, pilotSourceUrl, taskPrompt, verifyPilotSources, verifySourceBytes } from "../benchmarks/skillsbench-pilot/source.js";

const workspaces: string[] = [];
async function workspace() {
  const path = await mkdtemp(join(await realpath(tmpdir()), "skillsbench-source-"));
  workspaces.push(path);
  return path;
}
afterEach(async () => { await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("bounded SkillsBench source qualification", () => {
  it("locks exactly two complete task trees and LICENSE with both hashes", () => {
    expect(PILOT_SOURCE_LOCK).toHaveLength(31);
    expect(new Set(PILOT_SOURCE_LOCK.map(file => file.path)).size).toBe(31);
    for (const file of PILOT_SOURCE_LOCK) {
      expect(file.blob).toMatch(/^[a-f0-9]{40}$/);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pilotSourceUrl(file.path)).toBe(`https://raw.githubusercontent.com/benchflow-ai/skillsbench/${PILOT_COMMIT}/${file.path}`);
    }
  });
  it.each(["../LICENSE", "/LICENSE", "tasks/../LICENSE", "LICENSE?x", "LICENSE#x", "LICENSE%2f..", "LICENSE\\..", "tasks/other/task.md"])("rejects non-allowlisted route %s", path => {
    expect(() => pilotSourceUrl(path)).toThrow("Unpinned");
  });
  it("checks raw Git blob framing and SHA256 independently", () => {
    const bytes = Buffer.from("bounded fixture\n");
    const identity = { path: "fixture", size: bytes.length, blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), sha256: createHash("sha256").update(bytes).digest("hex") };
    expect(verifySourceBytes(bytes, identity)).toBe(bytes.toString());
    expect(() => verifySourceBytes(bytes, { ...identity, blob: "0".repeat(40) })).toThrow("hash drift");
    expect(() => verifySourceBytes(bytes, { ...identity, sha256: "0".repeat(64) })).toThrow("hash drift");
    expect(() => verifySourceBytes(Buffer.from("tampered fixture"), identity)).toThrow("hash drift");
  });
  it("rejects oversized, malformed UTF8 and NUL text", () => {
    expect(boundedUtf8(Buffer.alloc(65536, 65))).toHaveLength(65536);
    expect(() => boundedUtf8(Buffer.alloc(65537, 65))).toThrow("bound");
    expect(() => boundedUtf8(Uint8Array.of(0xc0, 0xaf))).toThrow();
    expect(() => boundedUtf8(Uint8Array.of(0))).toThrow("NUL");
  });
  it("projects only the task body, not metadata or other files", () => {
    expect(taskPrompt("---\r\nverifier: PRIVATE\r\nmetadata: PRIVATE\r\n---\r\n\r\nExport /root/output/object.obj\n")).toBe("Export /root/output/object.obj");
    expect(() => taskPrompt("---\nprivate: metadata\n")).toThrow("Unterminated");
    expect(() => taskPrompt("no frontmatter")).toThrow("Missing");
    expect(() => taskPrompt("---\na: b\n---\n")).toThrow("Empty");
  });
  it.each([301, 302, 404, 206, 500])("rejects HTTP %s without retry", async status => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status }));
    await expect(fetchPilotSources(await workspace(), mock)).rejects.toThrow("response");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe(pilotSourceUrl("LICENSE"));
    expect(mock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });
  it("rejects redirect metadata and unexpected final URLs even with HTTP 200", async () => {
    for (const props of [{ redirected: true }, { url: "https://example.com/LICENSE" }]) {
      const response = new Response("bad");
      for (const [key, value] of Object.entries(props)) Object.defineProperty(response, key, { value });
      await expect(fetchPilotSources(await workspace(), vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow("response");
    }
  });
  it("bounds streamed bytes and rejects hash tampering before publishing", async () => {
    for (const body of ["bad", "x".repeat(12000)]) {
      const root = await workspace();
      await expect(fetchPilotSources(root, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))).rejects.toThrow();
      await expect(readFile(join(root, PILOT_CACHE, "LICENSE"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("refuses existing drift without a request or overwrite", async () => {
    const root = await workspace();
    await mkdir(join(root, PILOT_CACHE), { recursive: true });
    const path = join(root, PILOT_CACHE, "LICENSE");
    await writeFile(path, "drift");
    const mock = vi.fn<typeof fetch>();
    await expect(fetchPilotSources(root, mock)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("drift");
    await expect(verifyPilotSources(root)).rejects.toThrow();
  });
  it.each(["symlink", "hardlink", "directory", "extra"])("rejects %s cache entries", async kind => {
    const root = await workspace();
    const cache = join(root, PILOT_CACHE);
    await mkdir(cache, { recursive: true });
    const outside = join(root, "outside");
    await writeFile(outside, "untouched");
    const path = join(cache, "LICENSE");
    if (kind === "symlink") await symlink(outside, path);
    if (kind === "hardlink") await link(outside, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "extra") await writeFile(join(cache, "unexpected"), "extra");
    const mock = vi.fn<typeof fetch>();
    await expect(fetchPilotSources(root, mock)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
  it("rejects symlinked cache ancestors", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, join(root, ".dal"));
    const mock = vi.fn<typeof fetch>();
    await expect(fetchPilotSources(root, mock)).rejects.toThrow("directory");
    expect(mock).not.toHaveBeenCalled();
  });
  it("supplies offline qualification primitives without candidate root mounts", () => {
    expect(pilotQualificationCommand("nop")).toEqual(["/bin/true"]);
    expect(pilotQualificationCommand("oracle")).toEqual(["/bin/bash", "/oracle/solve.sh"]);
    const verifier = pilotQualificationCommand("verify").join(" ");
    expect(verifier).toContain("/root/gen_ground_truth.mjs");
    expect(verifier).toContain("/verifier/test_outputs.py");
    expect(verifier).not.toMatch(/uvx|curl|test\.sh|pip install/);
    expect(pilotDockerBuildArgs().join(" ")).toMatch(/DSH_IMAGE=dsh-adaptive-loop\/skillsbench-base:[a-f0-9]{64}/);
    expect(pilotDockerBuildArgs()).not.toContain("--mount");
  });
});
