import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./json.js";

export type BuildFileMap = Record<string, string>;
export const BUILD_COMMAND = "pnpm run build";
export const BUILD_BUILDER = "benchmarks/tau-style-workflow/build-gateway-image.ts";
export interface E2eBuildProvenance {
  version: 1;
  builder: typeof BUILD_BUILDER;
  command: typeof BUILD_COMMAND;
  base_image_id: string;
  source_digest: string;
  artifact_digest: string;
  inputs: BuildFileMap;
  files: BuildFileMap;
}

const safePart = (name: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) && !/^(secrets?|node_modules)$/i.test(name);
export const buildMapDigest = (files: BuildFileMap): string => sha256(canonicalJson(files));

/** Only reviewed trees are traversed; hidden files and secret directories are never opened. */
export async function sourceInputMap(root: string): Promise<BuildFileMap> {
  const files: BuildFileMap = {};
  const add = async (path: string) => {
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Build input symlinks are forbidden");
    }
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Build input must be a regular file");
    files[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
  };
  const walk = async (path: string, extension: string): Promise<void> => {
    if (!(await lstat(join(root, path))).isDirectory()) throw new Error("Build input tree must be a real directory");
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (!safePart(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Build input symlinks are forbidden");
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, extension);
      else if (entry.name.endsWith(extension)) await add(child);
    }
  };
  await walk("src", ".ts");
  await walk("schemas", ".json");
  await add("package.json");
  await add(BUILD_BUILDER);
  for (const name of await readdir(root)) {
    if (/^tsconfig[a-zA-Z0-9_.-]*\.json$/.test(name) || name === "pnpm-lock.yaml") await add(name);
  }
  if (!files["tsconfig.json"] || !files["tsconfig.build.json"]) throw new Error("Missing build configuration");
  return files;
}

/** Only executable JS and schema JSON are shipped, not declarations, source maps or workspace data. */
export function expectedArtifactPaths(inputs: BuildFileMap): string[] {
  return Object.keys(inputs).flatMap(path => path.startsWith("schemas/") ? [path]
    : path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".d.ts")
      ? [`dist/${path.slice(4, -3)}.js`] : []).sort();
}

export async function artifactFileMap(root: string, inputs: BuildFileMap): Promise<BuildFileMap> {
  const files: BuildFileMap = {};
  for (const path of expectedArtifactPaths(inputs)) {
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Build artifact symlinks are forbidden");
    }
    if (!(await lstat(current)).isFile()) throw new Error("Build artifact must be a regular file");
    files[path] = createHash("sha256").update(await readFile(current)).digest("hex");
  }
  return files;
}

export function createBuildProvenance(before: BuildFileMap, after: BuildFileMap, files: BuildFileMap, base: string): E2eBuildProvenance {
  if (buildMapDigest(before) !== buildMapDigest(after)) throw new Error("Source inputs mutated during build");
  const provenance: E2eBuildProvenance = {
    version: 1, builder: BUILD_BUILDER, command: BUILD_COMMAND, base_image_id: base,
    source_digest: buildMapDigest(before), artifact_digest: buildMapDigest(files), inputs: before, files,
  };
  return verifyBuildProvenance(provenance, after, files);
}

export function verifyBuildProvenance(value: unknown, currentInputs: BuildFileMap, actualFiles: BuildFileMap): E2eBuildProvenance {
  const fail = (): never => { throw new Error("Invalid or stale image build provenance; rebuild the derived image before prepare"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const p = value as E2eBuildProvenance;
  if (Object.keys(p).sort().join() !== ["version", "builder", "command", "base_image_id", "source_digest", "artifact_digest", "inputs", "files"].sort().join()
    || p.version !== 1 || p.builder !== BUILD_BUILDER || p.command !== BUILD_COMMAND
    || !/^sha256:[a-f0-9]{64}$/.test(p.base_image_id)) return fail();
  for (const map of [p.inputs, p.files, actualFiles]) {
    if (!map || typeof map !== "object" || Array.isArray(map)) return fail();
    for (const [path, digest] of Object.entries(map)) {
      if (!path.split("/").every(safePart) || path.split("/").some(part => part === "." || part === "..")
        || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return fail();
    }
  }
  if (buildMapDigest(p.inputs) !== p.source_digest || p.source_digest !== buildMapDigest(currentInputs)
    || buildMapDigest(p.files) !== p.artifact_digest || p.artifact_digest !== buildMapDigest(actualFiles)
    || Object.keys(p.files).sort().join("\n") !== expectedArtifactPaths(currentInputs).join("\n")) return fail();
  for (const path of Object.keys(currentInputs).filter(path => path.startsWith("schemas/"))) {
    if (actualFiles[path] !== currentInputs[path]) return fail();
  }
  return p;
}

// Fixed trusted probe, not code imported from the image and not paths supplied by its manifest.
export const IMAGE_BUILD_PROBE = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto');
const root = '/opt/dal', files = {};
function walk(path, extension) {
  if (!fs.lstatSync(root + '/' + path).isDirectory()) throw Error('Unsafe artifact tree');
  for (const entry of fs.readdirSync(root + '/' + path, {withFileTypes:true})) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(entry.name) || /^(secrets?|node_modules)$/i.test(entry.name)) throw Error('Unsafe artifact name');
    const child = path + '/' + entry.name;
    if (entry.isSymbolicLink()) throw Error('Unsafe artifact link');
    if (entry.isDirectory()) walk(child, extension);
    else {
      if (!entry.isFile() || !entry.name.endsWith(extension)) throw Error('Unexpected artifact');
      files[child] = crypto.createHash('sha256').update(fs.readFileSync(root + '/' + child)).digest('hex');
    }
  }
}
if (!fs.lstatSync(root).isDirectory()) throw Error('Unsafe artifact root');
walk('dist', '.js'); walk('schemas', '.json');
const path = root + '/e2e-build-provenance.json';
if (!fs.lstatSync(path).isFile() || fs.lstatSync(path).isSymbolicLink() || fs.statSync(path).size > 4194304) throw Error('Unsafe provenance');
console.log(JSON.stringify({provenance:JSON.parse(fs.readFileSync(path, 'utf8')), files}));
`;

export async function verifyImageBuildProvenance(root: string, image: string): Promise<E2eBuildProvenance> {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Build inspection requires an immutable image ID");
  const inputs = await sourceInputMap(root);
  const probe = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", image, "-e", IMAGE_BUILD_PROBE],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (probe.error || probe.status !== 0) throw new Error("Missing or unreadable image build provenance; rebuild the derived image before prepare");
  let value: { provenance: unknown; files: BuildFileMap };
  try { value = JSON.parse(probe.stdout); } catch { throw new Error("Malformed image build provenance"); }
  if (!value || typeof value !== "object") throw new Error("Malformed image build provenance");
  const verified = verifyBuildProvenance(value.provenance, inputs, value.files);
  if (buildMapDigest(inputs) !== buildMapDigest(await sourceInputMap(root))) throw new Error("Source inputs mutated during image inspection");
  return verified;
}
