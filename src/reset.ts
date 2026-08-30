import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { DalError, isNodeError } from "./errors.js";
import { EVIDENCE_DIRECTORIES, EVIDENCE_GITIGNORE } from "./init.js";
import { prettyJson, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { ResetReceipt } from "./types.js";

/**
 * The acknowledgement token is the operator's explicit authorization at the
 * operation. Deterministic checks (clean tracked evidence, secret/PII scan,
 * directory safety) may block but never authorize. A reset deletes only local
 * workspace evidence; committed evidence remains recoverable from VCS history.
 */
export const RESET_ACKNOWLEDGE_TOKEN = "remove-all-evidence" as const;

const RESET_DIRECTORIES = [...EVIDENCE_DIRECTORIES, ".dal/resets"] as const;

export interface ResetStoreCounts {
  total_files: number;
  outbox: number;
  store: number;
  runs: number;
  clusters: number;
  other: number;
}

export interface ResetStatusResult {
  workspace: string;
  evidence_exists: boolean;
  git: { present: boolean; revision: string | null; dirty_paths: string[] };
  removed: ResetStoreCounts;
  stores_digest: string;
  blocks: string[];
  ready: boolean;
}

export interface ResetExecuteOptions {
  workspaceDir?: string;
  reason: string;
  actor?: string;
  acknowledge?: string;
}

export interface ResetExecuteResult {
  status: "reset";
  reset_id: string;
  receipt_path: string;
  stores_digest: string;
  revision: string | null;
  removed: ResetStoreCounts;
  next_steps: string[];
}

interface InventoryEntry {
  path: string;
  sha256: string;
}

function zeroCounts(): ResetStoreCounts {
  return { total_files: 0, outbox: 0, store: 0, runs: 0, clusters: 0, other: 0 };
}

async function inventoryStore(storeDir: string): Promise<{ entries: InventoryEntry[]; counts: ResetStoreCounts }> {
  const entries: InventoryEntry[] = [];
  async function walk(dir: string, base: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = base === "" ? entry.name : `${base}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        entries.push({ path: rel, sha256: sha256(await readFile(full)) });
      }
    }
  }
  await walk(storeDir, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const counts = zeroCounts();
  counts.total_files = entries.length;
  for (const entry of entries) {
    const top = entry.path.split("/")[0]!;
    if (top === "outbox") counts.outbox += 1;
    else if (top === "store") counts.store += 1;
    else if (top === "runs") counts.runs += 1;
    else if (top === "clusters") counts.clusters += 1;
    else counts.other += 1;
  }
  return { entries, counts };
}

function storesDigestOf(entries: InventoryEntry[]): string {
  return sha256(entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n"));
}

function gitRoot(root: string): boolean {
  return existsSync(join(root, ".git"));
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new DalError(
      "RESET_GIT_ERROR",
      "Git inspection failed; the reset cannot verify that the evidence is committed",
      [String(error)],
    );
  }
}

function gitRevision(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function gitBranch(root: string): string | null {
  const branch = runGit(root, ["branch", "--show-current"]);
  return branch === "" ? null : branch;
}

function evidenceDirtyPaths(root: string): string[] {
  const present = EVIDENCE_DIRECTORIES.filter((directory) => existsSync(join(root, directory)));
  if (present.length === 0) {
    return [];
  }
  const output = runGit(root, ["status", "--porcelain", "--", ...present]);
  return output === "" ? [] : output.split("\n");
}

async function storeMetadata(storeDir: string): Promise<{ exists: boolean }> {
  try {
    const metadata = await lstat(storeDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new DalError("RESET_INSECURE", "Refusing to remove .dal: it is not a directory");
    }
    return { exists: true };
  } catch (error) {
    if (error instanceof DalError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    return { exists: false };
  }
}

export async function resetStatus(options: { workspaceDir?: string } = {}): Promise<ResetStatusResult> {
  const root = resolve(process.cwd(), options.workspaceDir ?? ".");
  const storeDir = join(root, ".dal");
  const blocks: string[] = [];
  const { exists } = await storeMetadata(storeDir);
  const { entries, counts } = exists ? await inventoryStore(storeDir) : { entries: [], counts: zeroCounts() };
  const present = gitRoot(root);
  const dirtyPaths = present ? evidenceDirtyPaths(root) : [];
  const revision = present ? gitRevision(root) : null;
  if (dirtyPaths.length > 0) {
    blocks.push("RESET_DIRTY: uncommitted evidence under the tracked stores; commit it first");
  }
  return {
    workspace: root,
    evidence_exists: exists,
    git: { present, revision, dirty_paths: dirtyPaths },
    removed: counts,
    stores_digest: storesDigestOf(entries),
    blocks,
    ready: blocks.length === 0,
  };
}

async function ensureEvidenceGitignore(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!existing.includes(".dal/*")) {
    const separator = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(path, `${existing}${separator}${EVIDENCE_GITIGNORE}`, "utf8");
  }
}

export async function resetExecute(options: ResetExecuteOptions): Promise<ResetExecuteResult> {
  const root = resolve(process.cwd(), options.workspaceDir ?? ".");
  const reason = options.reason.trim();
  if (reason === "") {
    throw new DalError("USAGE_ERROR", "Missing required option --reason");
  }
  if (options.acknowledge !== RESET_ACKNOWLEDGE_TOKEN) {
    throw new DalError(
      "RESET_ACKNOWLEDGE_REQUIRED",
      `Reset removes all local evidence under .dal; re-run with --acknowledge ${RESET_ACKNOWLEDGE_TOKEN}`,
    );
  }
  const actor = (options.actor ?? "operator").trim() || "operator";
  assertNoSecrets(scanSecrets({ reason, actor }));
  assertNoPii(scanPii({ reason, actor }));

  const storeDir = join(root, ".dal");
  const { exists } = await storeMetadata(storeDir);
  const { entries, counts } = exists ? await inventoryStore(storeDir) : { entries: [], counts: zeroCounts() };
  const storesDigest = storesDigestOf(entries);

  const present = gitRoot(root);
  let revision: string | null = null;
  let branch: string | null = null;
  if (present) {
    const dirtyPaths = evidenceDirtyPaths(root);
    if (dirtyPaths.length > 0) {
      throw new DalError(
        "RESET_DIRTY",
        "Uncommitted evidence under the tracked stores; commit the evidence first so VCS history preserves it",
        dirtyPaths,
      );
    }
    revision = gitRevision(root);
    branch = gitBranch(root);
  }

  await rm(storeDir, { recursive: true, force: true });
  for (const directory of RESET_DIRECTORIES) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  }
  await ensureEvidenceGitignore(root);

  const receipt: ResetReceipt = {
    $schema: SCHEMA_IDS.resetReceipt,
    schema_version: "1.0.0",
    reset_id: `reset-${randomUUID()}`,
    action: "reset",
    repository: { root: `repo://${basename(root)}`, revision, branch, dirty: false },
    stores_digest: storesDigest,
    removed: counts,
    reason,
    actor,
    created_at: new Date().toISOString(),
  };
  assertNoSecrets(scanSecrets(receipt));
  assertNoPii(scanPii(receipt));
  await assertSchema(SCHEMA_IDS.resetReceipt, receipt, "Reset receipt");
  const receiptPath = join(storeDir, "resets", `${receipt.reset_id}.json`);
  await writeFile(receiptPath, prettyJson(receipt), { mode: 0o600 });

  return {
    status: "reset",
    reset_id: receipt.reset_id,
    receipt_path: relative(process.cwd(), receiptPath),
    stores_digest: storesDigest,
    revision,
    removed: counts,
    next_steps: [
      "The evidence stores were removed and empty stores were re-scaffolded under .dal/.",
      "Commit the removal and the reset receipt so the new baseline is recorded in VCS history.",
    ],
  };
}
