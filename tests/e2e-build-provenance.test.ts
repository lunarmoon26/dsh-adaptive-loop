import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import { artifactFileMap, BUILD_BUILDER, buildMapDigest, createBuildProvenance, expectedArtifactPaths, IMAGE_BUILD_PROBE, sourceInputMap, verifyBuildProvenance, verifyImageBuildProvenance } from "../src/e2e-build-provenance.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dal-build-provenance-")); roots.push(root);
  for (const [path, content] of Object.entries({
    "src/gateway.ts": "export const gateway = 1;", "src/types.d.ts": "export type X = string;",
    "schemas/policy.json": "{}", "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "tsconfig.json": "{}", "tsconfig.build.json": "{}", [BUILD_BUILDER]: "// builder",
    "dist/gateway.js": "export const gateway = 1;", ".env": "never-read", "src/.env": "never-read",
    "src/secrets/key.ts": "never-read", ".dal/private.ts": "never-read", "docs/operations.md": "instructions",
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
  const inputs = await sourceInputMap(root);
  const files = await artifactFileMap(root, inputs);
  const provenance = createBuildProvenance(inputs, inputs, files, `sha256:${"a".repeat(64)}`);
  return { root, inputs, files, provenance };
}

describe("reviewed source to executed image provenance", () => {
  it("uses canonical maps and excludes operational docs, env and private trees", async () => {
    const { root, inputs, files, provenance } = await fixture();
    expect(Object.keys(inputs)).not.toEqual(expect.arrayContaining([".env", "src/.env", "src/secrets/key.ts", ".dal/private.ts", "docs/operations.md"]));
    expect(expectedArtifactPaths(inputs)).toEqual(["dist/gateway.js", "schemas/policy.json"]);
    expect(verifyBuildProvenance(provenance, inputs, files)).toEqual(provenance);
    expect(buildMapDigest(Object.fromEntries(Object.entries(inputs).reverse()))).toBe(provenance.source_digest);
    await writeFile(join(root, "docs/operations.md"), "updated");
    expect(await sourceInputMap(root)).toEqual(inputs);
  });
  it("rejects source mutation during build and stale source at prepare", async () => {
    const { root, inputs, files, provenance } = await fixture();
    await writeFile(join(root, "src/gateway.ts"), "export const gateway = 2;");
    const changed = await sourceInputMap(root);
    expect(() => createBuildProvenance(inputs, changed, files, provenance.base_image_id)).toThrow("mutated");
    expect(() => verifyBuildProvenance(provenance, changed, files)).toThrow("stale");
  });
  it("rejects changed, missing and extra compiled files and changed schemas", async () => {
    const { inputs, files, provenance } = await fixture();
    for (const actual of [{ ...files, "dist/gateway.js": "b".repeat(64) }, { "schemas/policy.json": files["schemas/policy.json"]! }, { ...files, "dist/stale.js": "b".repeat(64) }, { ...files, "schemas/policy.json": "b".repeat(64) }]) {
      expect(() => verifyBuildProvenance(provenance, inputs, actual)).toThrow();
    }
    const changed = { ...files, "schemas/policy.json": "b".repeat(64) };
    expect(() => verifyBuildProvenance({ ...provenance, files: changed, artifact_digest: buildMapDigest(changed) }, inputs, changed)).toThrow();
  });
  it("rejects missing fields, malformed digests, checksums and arbitrary manifest paths", async () => {
    const { inputs, files, provenance } = await fixture();
    for (const key of Object.keys(provenance)) {
      const missing = { ...provenance } as Record<string, unknown>; delete missing[key];
      expect(() => verifyBuildProvenance(missing, inputs, files)).toThrow();
    }
    for (const value of [null, {}, [], { ...provenance, source_digest: "b".repeat(64) }, { ...provenance, artifact_digest: "bad" }, { ...provenance, command: "pnpm install" }]) {
      expect(() => verifyBuildProvenance(value, inputs, files)).toThrow();
    }
    for (const path of ["../.env", "/etc/passwd", "dist/../../.env", "dist/.env", "dist/extra.js"]) {
      const unsafe = { ...files, [path]: "b".repeat(64) };
      expect(() => verifyBuildProvenance({ ...provenance, files: unsafe, artifact_digest: buildMapDigest(unsafe) }, inputs, unsafe)).toThrow();
    }
  });
  it("does not follow source or artifact symlinks", async () => {
    const { root, inputs } = await fixture();
    await symlink(join(root, ".env"), join(root, "src/linked.ts"));
    await expect(sourceInputMap(root)).rejects.toThrow("symlinks");
    await rm(join(root, "dist/gateway.js")); await symlink(join(root, ".env"), join(root, "dist/gateway.js"));
    await expect(artifactFileMap(root, inputs)).rejects.toThrow("symlinks");
  });
  it("inspects only an immutable image using a fixed isolated probe and verifies its actual file map", async () => {
    const { root, files, provenance } = await fixture();
    const mock = vi.mocked(spawnSync);
    mock.mockReturnValue({ status: 0, stdout: JSON.stringify({ provenance, files }) } as ReturnType<typeof spawnSync>);
    expect(await verifyImageBuildProvenance(root, provenance.base_image_id)).toEqual(provenance);
    expect(mock.mock.calls[0]![1]).toEqual(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", provenance.base_image_id, "-e", IMAGE_BUILD_PROBE]);
    mock.mockReturnValue({ status: 0, stdout: JSON.stringify({ provenance, files: {} }) } as ReturnType<typeof spawnSync>);
    await expect(verifyImageBuildProvenance(root, provenance.base_image_id)).rejects.toThrow();
    mock.mockReturnValue({ status: 0, stdout: "not-json" } as ReturnType<typeof spawnSync>);
    await expect(verifyImageBuildProvenance(root, provenance.base_image_id)).rejects.toThrow("Malformed");
    mock.mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof spawnSync>);
    await expect(verifyImageBuildProvenance(root, provenance.base_image_id)).rejects.toThrow("Missing");
    await expect(verifyImageBuildProvenance(root, "mutable:tag")).rejects.toThrow("immutable");
  });
  it("keeps compilation before context copying and provenance publication exclusive", async () => {
    const builder = await readFile(join(import.meta.dirname, "..", BUILD_BUILDER), "utf8");
    expect(builder.indexOf('spawnSync("pnpm", ["run", "build"]')).toBeLessThan(builder.indexOf("await copyFile("));
    expect(builder).toContain('flag: "wx"');
    expect(builder).not.toMatch(/pnpm.*install|COPY \. |cp\(join\(root/);
  });
  it("executes the fixed probe against actual bytes and rejects unexpected inventory and links", async () => {
    const { root, inputs, files, provenance } = await fixture();
    await writeFile(join(root, "e2e-build-provenance.json"), JSON.stringify(provenance));
    const bound = (path: string) => {
      if (path !== "/opt/dal" && !path.startsWith("/opt/dal/")) throw new Error("Unbounded probe read");
      return root + path.slice("/opt/dal".length);
    };
    const probe = () => {
      let output = "";
      runInNewContext(IMAGE_BUILD_PROBE, {
        require: (name: string) => name === "node:crypto" ? crypto : {
          lstatSync: (path: string) => fs.lstatSync(bound(path)),
          statSync: (path: string) => fs.statSync(bound(path)),
          readdirSync: (path: string) => fs.readdirSync(bound(path), { withFileTypes: true }),
          readFileSync: (path: string, encoding?: BufferEncoding) => fs.readFileSync(bound(path), encoding),
        },
        console: { log: (value: string) => { output = value; } },
      });
      return JSON.parse(output);
    };
    expect(probe()).toEqual({ provenance, files });
    await writeFile(join(root, "dist/gateway.js"), "modified compiled bytes");
    expect(() => verifyBuildProvenance(probe().provenance, inputs, probe().files)).toThrow("stale");
    await writeFile(join(root, "dist/extra.js"), "extra");
    expect(() => verifyBuildProvenance(provenance, inputs, probe().files)).toThrow();
    await symlink(join(root, ".env"), join(root, "dist/link.js"));
    expect(probe).toThrow("link");
  });
});
