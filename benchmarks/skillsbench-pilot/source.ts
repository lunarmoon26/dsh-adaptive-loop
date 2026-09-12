import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const PILOT_COMMIT = "9a1f4dd5f7659f75707435da3ce854b6e48321d1";
export const PILOT_CACHE = ".dal/check/skillsbench-pilot/upstream";
export const PILOT_TASKS = Object.freeze({ development: "threejs-to-obj", transfer: "threejs-structure-parser" } as const);
export type PilotTask = typeof PILOT_TASKS[keyof typeof PILOT_TASKS];
export interface SourceIdentity { readonly path: string; readonly blob: string; readonly size: number; readonly sha256: string }
const MAX_TEXT_BYTES = 64 * 1024;

// Public recursive Git tree, untruncated, at PILOT_COMMIT. SHA256 values were
// independently computed from raw bytes after checking the Git blob identities.
const shared = [
  "environment/skills/threejs/SKILL.md fb3860d7231d4d6218cf7e5c379ab353b6bc1433 3268 ea480298751ea55effee4535b16b67ec79fd9540b971a89712e6f5b9ce8cd663",
  "environment/skills/threejs/references/joint-type-heuristics.md 51c9c47753f2a2a44e08cf43ab1efd61a63d778b 1083 459af44b906bb2bf61a940e88b83b1cf7afe3ddb17c17d355577f987c6a6214b",
  "environment/skills/threejs/references/link-export-rules.md 3938fd01fb087fd4eb5f717cfc864f59cd1d5a03 680 7c664561c879a7be8d799665f781ba8497abcdbf34ec6c369121fd57d699b835",
  "environment/skills/threejs/references/urdf-minimal.md b44b0c4b86fab4d5ec795353806586f1f0b8eb76 677 204b4ae283774fe2a8181a605aa9f0d79355f6c8bf4b060c53891a2136750aee",
  "environment/skills/threejs/scripts/build_urdf_from_scene.mjs 17d1975031651e98eff76e31c1e2d7699df05191 3915 db916f0930dd39a8e4a17ee2ddb4b166bdc41df57baacc46123fa65a052fe284",
  "environment/skills/threejs/scripts/export_instanced_obj.mjs 6ff86943af2a6470b421ee8be8a7bf7819b06647 1758 b2d33217a6d67ecfc877bfe2d696d681409723f6ed5b5be1e12b75922a90de82",
  "environment/skills/threejs/scripts/export_link_objs.mjs 40584d360fcd4afdc51400dedde731b0485a9b55 2861 95772be1810e9bea114197265a0f3094bc98607b9b871e80a34d5d7131d33494",
];
const taskRows: Record<PilotTask, string[]> = {
  "threejs-to-obj": [
    "environment/Dockerfile ddb8d75ca39a8bda688baf926a9fe1977ffda529 620 bbf8f913b40a2286c4478877177c787b06e88c3d05ffdd830a999ca5c90e82d5",
    "environment/data/object.js 5551dcc36dd91f5d6bb5594db5692f63deb69bc5 5647 ab0685be0319d853d001af87c3f4d7cc9fde7f384bb46d2364582d4fc771c182",
    "environment/skills/obj-exporter/SKILL.md 5be7ce6b598fbe83bfde5a3d41c7fc3f0c1c1d41 2055 e6681249baeab46443a2ddd1ef7983099dced6851b18dba3572b3967e5548056",
    "oracle/solve.sh 60d4d26b8b787f0feaf186c8ce078ef678359c0b 2794 35d8055c2b9ef26b9af737d55dd7c90df5c4e6e0cc5f5cd91a647263caf80e8b",
    "task.md 7e8a253d15302173794ee632ca1e394b9adc355d 1306 7fd36dcddabb1509f4c6ad2d9aa51a5e124c9ad617f06a2ffafc24c7283ae9b7",
    "verifier/gen_ground_truth.mjs b6af263f094d7d4ef19f7f5011ba55dd59798b50 2053 210b32a6b77aa02b5bba4ec008be836f5c96bf3daa2511e9a42a1f069d2efecd",
    "verifier/test.sh 21c534cd96eccde196e30645225b16661ec85b16 1252 04f77d1342c0106060bca0d7b40aa2e429e11bbc2e0bd0200524b2b00feaca9c",
    "verifier/test_outputs.py 417ee8b13e4f332fa3ac0d0ad3a106bd36ca4342 3235 2e8ca83fb5ddeb3ba323cfa9d0a282ed2911e69623fbadf251263c560c3a6226",
  ],
  "threejs-structure-parser": [
    "environment/Dockerfile a13ef155b2038379505d00a3c3a8f956d8f96990 592 2fcde1fd669428319ad6d0117367ad81d2fb5ce25f9ad503ade9ab24bd01409f",
    "environment/data/object.js 2fb633436179aaa3e6e1ef9a20a8d18755a3d6e1 10439 2de9dacd93a02e43c0699a03a1ee2b75ce0366d418c095e9be49b964ead7c3f4",
    "environment/skills/obj-exporter/SKILL.md f914e35b6adf6f2b1810690a9fa010cb77b28547 4576 92f851fcd69db38dc72e85f789f06557fc3e82c59d33d580fb977a72f8e587aa",
    "oracle/solve.sh 303226a7d5958df73725ad97a7c3a589faa96286 4248 3dc9174cf12d53afb726c8fff3f488ddde9378b64ee0200779ccfbae45aba665",
    "task.md 3640f1beb19ba9dbe29f5274fbafb3bb0942808d 1848 ecd5bb26740662db050464fd6b4553d65e8d5c6c3d0b048215bbe6d042680145",
    "verifier/gen_ground_truth.mjs 1223578234b78b44550c97acaf6cb48214fcf717 4175 d467bee99a9ce693665c8490df78753e7b05840c0437402769943b4c7e16307c",
    "verifier/test.sh 03febda0dec07568ea9ff9db9805f0ab30b5d6fe 1424 e265fcab20f8bcce62ce9c227f8ec570225dc24226d09bb863f9036cda92595f",
    "verifier/test_outputs.py a63e067c0d4a6a30474aa562408e8a6eed72afc0 4606 9fcbb9bd95cb3e9d65569874f795270bdd243421e333507c6a2be8e0f776d194",
  ],
};
export const PILOT_SOURCE_LOCK: readonly SourceIdentity[] = Object.freeze([
  "LICENSE 261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64 11357 c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  ...Object.values(PILOT_TASKS).flatMap(task => [...taskRows[task], ...shared].map(row => `tasks/${task}/${row}`)),
].map(row => {
  const [path, blob, size, sha256] = row.split(" ") as [string, string, string, string];
  return Object.freeze({ path, blob, size: Number(size), sha256 });
}));

export function pilotSourceUrl(path: string): string {
  if (!PILOT_SOURCE_LOCK.some(file => file.path === path)) throw new Error("Unpinned source path");
  return `https://raw.githubusercontent.com/benchflow-ai/skillsbench/${PILOT_COMMIT}/${path}`;
}

export function boundedUtf8(bytes: Uint8Array): string {
  if (bytes.length > MAX_TEXT_BYTES) throw new Error("Text byte bound exceeded");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("NUL in text");
  return text;
}

export function verifySourceBytes(bytes: Uint8Array, identity: SourceIdentity): string {
  const text = boundedUtf8(bytes);
  if (bytes.length !== identity.size ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== identity.blob ||
      createHash("sha256").update(bytes).digest("hex") !== identity.sha256) throw new Error("Source hash drift");
  return text;
}

// No YAML evaluation: only task.md's body is candidate-facing, never metadata,
// source inventory, skills, oracle, verifier, or a concatenated task directory.
export function taskPrompt(markdown: string): string {
  const text = boundedUtf8(Buffer.from(markdown)).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) throw new Error("Missing task frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Unterminated task frontmatter");
  const body = text.slice(end + 5).trim();
  if (!body) throw new Error("Empty task prompt");
  return body;
}

async function directories(path: string, create: boolean): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe cache directory");
  }
}

async function readSource(root: string, file: SourceIdentity): Promise<Buffer> {
  const path = join(root, file.path);
  await directories(dirname(path), false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== file.size || before.size > MAX_TEXT_BYTES) {
      throw new Error("Unsafe cache file or size drift");
    }
    const bytes = Buffer.alloc(file.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    await directories(dirname(path), false);
    if (after.nlink !== 1 || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Cache changed during read");
    }
    const content = bytes.subarray(0, count);
    verifySourceBytes(content, file);
    return content;
  } finally { await handle.close(); }
}

async function inspectCache(root: string): Promise<void> {
  await directories(root, false);
  const files = new Set(PILOT_SOURCE_LOCK.map(file => file.path));
  const dirs = new Set<string>();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") { dirs.add(parent); parent = dirname(parent); }
  }
  async function walk(relative: string): Promise<void> {
    for (const name of await readdir(join(root, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, child));
      if (stat.isSymbolicLink()) throw new Error("Unsafe cache symlink");
      if (stat.isDirectory() && dirs.has(child)) await walk(child);
      else if (!stat.isFile() || stat.nlink !== 1 || !files.has(child)) throw new Error("Unexpected cache entry");
    }
  }
  await walk("");
}

export interface PilotSources {
  root: string;
  commit: typeof PILOT_COMMIT;
  inventory: readonly SourceIdentity[];
  prompts: Record<PilotTask, string>;
}

export async function verifyPilotSources(workspace = process.cwd()): Promise<PilotSources> {
  const root = resolve(workspace, PILOT_CACHE);
  await inspectCache(root);
  const prompts = {} as Record<PilotTask, string>;
  for (const file of PILOT_SOURCE_LOCK) {
    const bytes = await readSource(root, file);
    for (const task of Object.values(PILOT_TASKS)) {
      if (file.path === `tasks/${task}/task.md`) prompts[task] = taskPrompt(boundedUtf8(bytes));
    }
  }
  return { root, commit: PILOT_COMMIT, inventory: PILOT_SOURCE_LOCK, prompts };
}

// Caller owns a private, non-concurrently-mutated cache ancestor. Portable Node
// has no openat directory handles; this is not a hostile same-UID sandbox.
export async function fetchPilotSources(workspace = process.cwd(), fetcher: typeof fetch = fetch): Promise<PilotSources> {
  const root = resolve(workspace, PILOT_CACHE);
  await directories(root, true);
  await inspectCache(root);
  // Reject all existing drift before making any network request.
  const missing: SourceIdentity[] = [];
  for (const file of PILOT_SOURCE_LOCK) {
    try { await readSource(root, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(file);
    }
  }
  for (const file of missing) {
    const url = pilotSourceUrl(file.path);
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000), credentials: "omit" });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body) {
      await response.body?.cancel();
      throw new Error("Invalid pinned source response");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > file.size || size > MAX_TEXT_BYTES) throw new Error("Download byte bound exceeded");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    verifySourceBytes(bytes, file);
    const path = join(root, file.path);
    await directories(dirname(path), true);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await readSource(root, file);
  }
  return verifyPilotSources(workspace);
}

export const PILOT_DSH_IMAGE = "sha256:cfc34cdf3dc774ad2f2f388220f168b41832601b6c397418e7260db111c1823e";
export const PILOT_BASE_TAG = `dsh-adaptive-loop/skillsbench-base:${PILOT_DSH_IMAGE.slice(7)}`;
export function pilotDockerBuildArgs(): string[] {
  return ["build", "--build-arg", `DSH_IMAGE=${PILOT_BASE_TAG}`, "-f", "benchmarks/skillsbench-pilot/Dockerfile", "benchmarks/skillsbench-pilot"];
}

// Commands only, never execution. Run in separate fresh offline containers.
// Candidate gets projected data/skills only, NEVER upstream root or private files.
// Verifier gets pristine input and private scripts, plus bounded non-link output
// files collected after candidate termination. Main owns that isolation boundary.
export function pilotQualificationCommand(mode: "oracle" | "nop" | "verify"): string[] {
  if (mode === "oracle") return ["/bin/bash", "/oracle/solve.sh"];
  if (mode === "nop") return ["/bin/true"];
  if (mode !== "verify") throw new Error("Unknown qualification mode");
  return ["/bin/bash", "-euc", "cp /verifier/gen_ground_truth.mjs /root/gen_ground_truth.mjs; node /root/gen_ground_truth.mjs; exec /opt/pilot-venv/bin/python -I -m pytest -c /dev/null --confcutdir=/verifier -p no:cacheprovider --junitxml=/verification/junit.xml /verifier/test_outputs.py -rA"];
}
