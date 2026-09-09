/** Build a local-only derived image from an existing DSH image; never send the repository context. */
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { artifactFileMap, createBuildProvenance, sourceInputMap, verifyBuildProvenance, verifyImageBuildProvenance } from "../../src/e2e-build-provenance.js";

const root = resolve(import.meta.dirname, "../..");
const base = "dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2";
const tag = "dsh-adaptive-loop/dsh:0.1.1-rc.2-metered-e2e";
function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`Local gateway image ${args[0]} failed: ${result.stderr || "process failed"}`);
  return result.stdout.trim();
}
const baseId = docker(["image", "inspect", "--format", "{{.Id}}", base]);
if (!/^sha256:[a-f0-9]{64}$/.test(baseId)) throw new Error("Missing immutable local base image");
const pinnedBase = `dsh-adaptive-loop/e2e-base:${baseId.slice(7)}`;
docker(["tag", baseId, pinnedBase]);
const baseUser = docker(["image", "inspect", "--format", "{{.Config.User}}", baseId]);
if (baseUser && !/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(baseUser)) throw new Error("Unsupported base image user");
const before = await sourceInputMap(root);
const build = spawnSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit", timeout: 120000 });
if (build.error || build.status !== 0) throw new Error("Local compilation failed; no image built");
const after = await sourceInputMap(root);
const provenance = createBuildProvenance(before, after, await artifactFileMap(root, after), baseId);
const parent = join(root, ".dal/check");
await mkdir(parent, { recursive: true, mode: 0o700 });
const context = await mkdtemp(join(parent, "gateway-build-"));
for (const path of Object.keys(provenance.files)) {
  await mkdir(dirname(join(context, path)), { recursive: true, mode: 0o755 });
  await copyFile(join(root, path), join(context, path));
}
verifyBuildProvenance(provenance, await sourceInputMap(root), await artifactFileMap(context, after));
await writeFile(join(context, "e2e-build-provenance.json"), JSON.stringify(provenance), { flag: "wx", mode: 0o644 });
// Remove inherited dist/schema files so COPY cannot leave stale executable artifacts behind.
await writeFile(join(context, "Dockerfile"), `FROM ${pinnedBase}\nUSER root\nRUN rm -rf /opt/dal/dist /opt/dal/schemas\nCOPY dist /opt/dal/dist\nCOPY schemas /opt/dal/schemas\nCOPY e2e-build-provenance.json /opt/dal/e2e-build-provenance.json\nUSER ${baseUser || "root"}\n`, { flag: "wx", mode: 0o600 });
if (docker(["image", "inspect", "--format", "{{.Id}}", base]) !== baseId) throw new Error("Local base changed before image build");
docker(["build", "--pull=false", "--network", "none", "--tag", tag, context]);
if (docker(["image", "inspect", "--format", "{{.Id}}", base]) !== baseId) throw new Error("Local base changed during build");
if (docker(["image", "inspect", "--format", "{{.Id}}", pinnedBase]) !== baseId) throw new Error("Pinned local base changed during build");
const image = docker(["image", "inspect", "--format", "{{.Id}}", tag]);
const verified = await verifyImageBuildProvenance(root, image);
if (verified.artifact_digest !== provenance.artifact_digest || verified.base_image_id !== baseId) throw new Error("Final image provenance mismatch");
console.log(JSON.stringify({ image, tag, base_image: baseId, context, network: "none", source_digest: verified.source_digest, artifact_digest: verified.artifact_digest }));
