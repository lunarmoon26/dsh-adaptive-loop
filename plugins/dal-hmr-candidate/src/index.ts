import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Service, type Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dal-hmr-candidate";
export const inject = ["hmr", "tools"];

export interface Config {
  /** Absolute or process-relative root of a linked git worktree. */
  workspaceRoot?: string;
  /** Loaded plugin entry, relative to workspaceRoot. Must also occur in files. */
  entry: string;
  /** Fixed, existing plugin/config-module files that form one candidate. */
  files: string[];
  /** Fixed staging directory relative to workspaceRoot. */
  stagingRoot?: string;
  /** Retained for configuration compatibility; ignored while admission is quarantined. */
  approvalFile?: string;
  /** Retained for configuration compatibility; ignored while admission is quarantined. */
  approvalScope?: string;
  /** Retained for configuration compatibility; ignored while admission is quarantined. */
  approvalCommand?: string[];
  /** Pinned DSH package version used by the workbench profile. */
  dshVersion: string;
  /** DSH profile identity used by the workbench. */
  profile: string;
  /** Retained for configuration compatibility; ignored while admission is quarantined. */
  timeoutMs?: number;
}

export interface CandidateGeneration {
  candidateId: string | null;
  candidateSha256: string;
  hmrSequence: number;
  admitted: boolean;
  gitTree: string;
  dshVersion: string;
  profile: string;
}

export interface CandidateStatus {
  preparedCandidateId?: string;
  sourceSha256: string;
  stagedSha256?: string;
  activeCandidateId?: string;
  activeCandidateSha256: string;
  hmrSequence: number;
  admitted: boolean;
  stagingRoot: string;
  gitTree: string;
  dshVersion: string;
  profile: string;
}

interface FileTarget {
  relativePath: string;
  sourcePath: string;
  stagingPath: string;
}

interface FileState {
  bytes: Buffer;
  mode: number;
}

type Snapshot = Map<string, FileState>;

interface PreparedCandidate {
  id: string;
  baselineSha256: string;
}

interface ReloadLike {
  filename: string;
}

interface HmrEventContext {
  on(name: string, listener: (...args: unknown[]) => unknown): unknown;
}

interface ResolvedConfig {
  workspaceRoot: string;
  entryUrl: string;
  files: FileTarget[];
  stagingRoot: string;
  stagingRootRelative: string;
  gitTree: string;
  dshVersion: string;
  profile: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    dalCandidate: CandidateCoordinator;
  }
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export class CandidateError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CandidateError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new CandidateError(code, message, cause === undefined ? undefined : { cause });
}

function canonicalRelative(input: string, label: string): string {
  if (input === "" || input.includes("\0") || isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    fail("CANDIDATE_CONFIG_INVALID", `${label} must be a non-empty relative path`);
  }
  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("CANDIDATE_CONFIG_INVALID", `${label} must be canonical and traversal-free`);
  }
  return segments.join("/");
}

function inside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

async function assertRegularFile(path: string, root: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    fail("CANDIDATE_PATH_INVALID", `${label} must be an existing regular file`, error);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("CANDIDATE_PATH_INVALID", `${label} must be a regular file, not a link`);
  }
  const canonical = await realpath(path);
  if (!inside(root, canonical) || canonical !== path) {
    fail("CANDIDATE_PATH_INVALID", `${label} must not resolve through a link or outside the worktree`);
  }
}

async function assertLinkedWorktree(workspaceRoot: string, markerText: string): Promise<string> {
  const output = await new Promise<string>((resolveGit, rejectGit) => {
    execFile(
      "git",
      [
        "-C",
        workspaceRoot,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "HEAD^{tree}",
      ],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error === null) resolveGit(stdout);
        else rejectGit(error);
      },
    );
  }).catch((error: unknown) => fail("CANDIDATE_WORKTREE_REQUIRED", "workspaceRoot must be a valid linked git worktree", error));
  const [reportedRoot, reportedGitDir, reportedCommonDir, gitTree, ...extra] = output.trim().split("\n").map((line) => line.trim());
  if (
    reportedRoot === undefined
    || reportedGitDir === undefined
    || reportedCommonDir === undefined
    || gitTree === undefined
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitTree)
    || extra.length > 0
  ) {
    fail("CANDIDATE_WORKTREE_REQUIRED", "git returned an unexpected worktree identity");
  }
  const [canonicalRoot, canonicalGitDir, canonicalCommonDir] = await Promise.all([
    realpath(reportedRoot),
    realpath(reportedGitDir),
    realpath(reportedCommonDir),
  ]);
  const markerValue = markerText.trim().slice("gitdir: ".length);
  const markerGitDir = await realpath(resolve(workspaceRoot, markerValue));
  if (canonicalRoot !== workspaceRoot || canonicalGitDir !== markerGitDir || canonicalGitDir === canonicalCommonDir) {
    fail("CANDIDATE_WORKTREE_REQUIRED", "workspaceRoot is not an isolated linked git worktree");
  }
  return gitTree;
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  if (!inside(root, directory)) {
    fail("CANDIDATE_PATH_INVALID", "candidate write directory is outside the worktree");
  }
  const segments = relative(root, directory).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        fail("CANDIDATE_PATH_INVALID", `candidate write path traverses a non-directory: ${relative(root, cursor)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor, { mode: 0o700 });
    }
  }
}

async function writeAtomic(root: string, destination: string, state: FileState): Promise<void> {
  const parent = dirname(destination);
  await ensureDirectory(root, parent);
  const temporary = join(parent, `.${randomUUID()}.dal-candidate.tmp`);
  const handle = await open(temporary, "wx", state.mode & 0o777);
  try {
    await handle.writeFile(state.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function digestSnapshot(snapshot: Snapshot): string {
  const hash = createHash("sha256");
  for (const [relativePath, state] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    hash.update(String(pathBytes.length));
    hash.update(":");
    hash.update(pathBytes);
    hash.update(":");
    hash.update(String(state.bytes.length));
    hash.update(":");
    hash.update(state.bytes);
  }
  return hash.digest("hex");
}

function snapshotSync(files: FileTarget[], key: "sourcePath" | "stagingPath"): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const file of files) {
    const path = file[key];
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail("CANDIDATE_PATH_INVALID", `${file.relativePath} is not a regular file`);
    }
    if (realpathSync(path) !== path) {
      fail("CANDIDATE_PATH_INVALID", `${file.relativePath} resolves through a link`);
    }
    snapshot.set(file.relativePath, { bytes: readFileSync(path), mode: info.mode });
  }
  return snapshot;
}

async function snapshot(files: FileTarget[], key: "sourcePath" | "stagingPath", root: string): Promise<Snapshot> {
  const result: Snapshot = new Map();
  for (const file of files) {
    const path = file[key];
    await assertRegularFile(path, root, file.relativePath);
    const info = await lstat(path);
    result.set(file.relativePath, { bytes: await readFile(path), mode: info.mode });
  }
  return result;
}

function sameEntry(entryUrl: string, filename: string): boolean {
  try {
    return pathToFileURL(realpathSync(fileURLToPath(filename))).href === entryUrl;
  } catch {
    return false;
  }
}

async function resolveConfig(config: Config): Promise<ResolvedConfig> {
  if (!Array.isArray(config.files) || config.files.length === 0) {
    fail("CANDIDATE_CONFIG_INVALID", "files must contain at least the loaded plugin entry");
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(config.dshVersion)) {
    fail("CANDIDATE_CONFIG_INVALID", "dshVersion must be a semantic version");
  }
  if (typeof config.profile !== "string" || config.profile.length === 0 || config.profile.length > 128 || /[\r\n]/.test(config.profile)) {
    fail("CANDIDATE_CONFIG_INVALID", "profile must be a non-empty single-line identity");
  }
  const workspaceRoot = await realpath(resolve(config.workspaceRoot ?? process.cwd()));
  const gitMarker = join(workspaceRoot, ".git");
  let marker;
  try {
    marker = await lstat(gitMarker);
  } catch (error) {
    fail("CANDIDATE_WORKTREE_REQUIRED", "workspaceRoot must be a linked git worktree", error);
  }
  if (!marker.isFile() || marker.isSymbolicLink()) {
    fail("CANDIDATE_WORKTREE_REQUIRED", "workspaceRoot must be a linked git worktree");
  }
  const markerText = await readFile(gitMarker, "utf8");
  if (!markerText.startsWith("gitdir: ")) fail("CANDIDATE_WORKTREE_REQUIRED", "invalid linked-worktree marker");
  const gitTree = await assertLinkedWorktree(workspaceRoot, markerText);

  const entry = canonicalRelative(config.entry, "entry");
  const relatives = config.files.map((file, index) => canonicalRelative(file, `files[${index}]`));
  if (new Set(relatives).size !== relatives.length) {
    fail("CANDIDATE_CONFIG_INVALID", "files must not contain duplicates");
  }
  if (!relatives.includes(entry)) {
    fail("CANDIDATE_CONFIG_INVALID", "entry must also occur in files");
  }
  const entryDirectoryEnd = entry.lastIndexOf("/");
  if (entryDirectoryEnd < 1) {
    fail("CANDIDATE_CONFIG_INVALID", "entry must be inside a dedicated plugin directory");
  }
  const editableRoot = entry.slice(0, entryDirectoryEnd + 1);
  if (relatives.some((relativePath) => !relativePath.startsWith(editableRoot) || relativePath.startsWith(".git/") || relativePath.startsWith(".dal/"))) {
    fail("CANDIDATE_CONFIG_INVALID", "every candidate file must stay inside the entry directory and outside reserved metadata");
  }

  const stagingRootRelative = canonicalRelative(config.stagingRoot ?? ".dal/hmr-candidate", "stagingRoot");
  if (!stagingRootRelative.startsWith(".dal/")) {
    fail("CANDIDATE_CONFIG_INVALID", "stagingRoot must stay under .dal/");
  }
  const stagingRoot = resolve(workspaceRoot, stagingRootRelative);
  if (!inside(workspaceRoot, stagingRoot)) {
    fail("CANDIDATE_CONFIG_INVALID", "stagingRoot must be inside workspaceRoot");
  }
  const files: FileTarget[] = [];
  for (const relativePath of relatives.sort()) {
    const sourcePath = resolve(workspaceRoot, relativePath);
    if (!inside(workspaceRoot, sourcePath) || sourcePath === stagingRoot || inside(stagingRoot, sourcePath)) {
      fail("CANDIDATE_CONFIG_INVALID", `${relativePath} overlaps the staging root`);
    }
    await assertRegularFile(sourcePath, workspaceRoot, relativePath);
    files.push({ relativePath, sourcePath, stagingPath: resolve(stagingRoot, relativePath) });
  }

  const entryPath = resolve(workspaceRoot, entry);
  const entryUrl = pathToFileURL(await realpath(entryPath)).href;
  return {
    workspaceRoot,
    entryUrl,
    files,
    stagingRoot,
    stagingRootRelative,
    gitTree,
    dshVersion: config.dshVersion,
    profile: config.profile,
  };
}

export class CandidateCoordinator extends Service {
  #sequence = 0;
  #generation: CandidateGeneration;
  #prepared: PreparedCandidate | undefined;
  #busy = false;
  readonly #config: ResolvedConfig;

  static async create(ctx: Context, config: Config): Promise<CandidateCoordinator> {
    const resolved = await resolveConfig(config);
    return new CandidateCoordinator(ctx, resolved);
  }

  private constructor(
    ctx: Context,
    config: ResolvedConfig,
  ) {
    super(ctx, "dalCandidate");
    this.#config = config;
    this.#generation = {
      candidateId: null,
      candidateSha256: digestSnapshot(snapshotSync(this.#config.files, "sourcePath")),
      hmrSequence: 0,
      admitted: false,
      gitTree: this.#config.gitTree,
      dshVersion: this.#config.dshVersion,
      profile: this.#config.profile,
    };
    for (const method of ["currentGeneration", "status", "prepare", "applyPrepared", "reject"] as const) {
      Object.defineProperty(this, method, {
        configurable: false,
        enumerable: false,
        value: this[method],
        writable: false,
      });
    }
    (ctx as unknown as HmrEventContext).on("hmr/reload", (reloads) => {
      this.#observeReload(reloads);
    });
  }

  currentGeneration = (): CandidateGeneration => {
    return { ...this.#generation };
  };

  status = async (): Promise<CandidateStatus> => {
    const sourceSha256 = digestSnapshot(await snapshot(this.#config.files, "sourcePath", this.#config.workspaceRoot));
    let stagedSha256: string | undefined;
    if (this.#prepared !== undefined) {
      try {
        stagedSha256 = digestSnapshot(await snapshot(this.#config.files, "stagingPath", this.#config.workspaceRoot));
      } catch {
        stagedSha256 = undefined;
      }
    }
    return {
      ...(this.#prepared === undefined ? {} : { preparedCandidateId: this.#prepared.id }),
      sourceSha256,
      ...(stagedSha256 === undefined ? {} : { stagedSha256 }),
      ...(this.#generation.candidateId === null ? {} : { activeCandidateId: this.#generation.candidateId }),
      activeCandidateSha256: this.#generation.candidateSha256,
      hmrSequence: this.#generation.hmrSequence,
      admitted: this.#generation.admitted,
      stagingRoot: this.#config.stagingRootRelative,
      gitTree: this.#config.gitTree,
      dshVersion: this.#config.dshVersion,
      profile: this.#config.profile,
    };
  };

  prepare = async (candidateId: string): Promise<CandidateStatus> => {
    return this.#exclusive(async () => {
      if (!IDENTIFIER.test(candidateId) || candidateId.length < 3 || candidateId.length > 128) {
        fail("CANDIDATE_ID_INVALID", "candidate id must satisfy the DAL identifier contract");
      }
      if (this.#generation.candidateId !== null) {
        fail("CANDIDATE_ACTIVE", "reject or promote the active candidate before preparing another");
      }
      const baseline = await snapshot(this.#config.files, "sourcePath", this.#config.workspaceRoot);
      for (const target of this.#config.files) {
        await writeAtomic(this.#config.workspaceRoot, target.stagingPath, baseline.get(target.relativePath)!);
      }
      this.#prepared = { id: candidateId, baselineSha256: digestSnapshot(baseline) };
      return this.status();
    });
  };

  applyPrepared = async (): Promise<CandidateGeneration> => {
    fail(
      "CANDIDATE_ADMISSION_QUARANTINED",
      "HMR candidate application is quarantined until DSH provides runtime-closure identity and an awaited activation-readiness boundary",
    );
  };

  reject = async (): Promise<CandidateGeneration> => {
    return this.#exclusive(async () => {
      const prepared = this.#prepared;
      if (prepared === undefined) fail("CANDIDATE_NOT_PREPARED", "there is no prepared candidate to reject");
      const liveSha256 = digestSnapshot(await snapshot(this.#config.files, "sourcePath", this.#config.workspaceRoot));
      if (liveSha256 === prepared.baselineSha256 && this.#generation.candidateId === null) {
        this.#prepared = undefined;
        return this.currentGeneration();
      }
      fail(
        "CANDIDATE_REJECTION_QUARANTINED",
        "live candidate files changed after staging; quarantined rejection refuses to overwrite them",
      );
    });
  };

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) fail("CANDIDATE_BUSY", "another candidate operation is still active");
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  #observeReload(value: unknown): void {
    if (!(value instanceof Map)) return;
    this.#sequence += 1;
    let matchesEntry = false;
    for (const reload of value.values()) {
      if (
        typeof reload === "object"
        && reload !== null
        && typeof (reload as ReloadLike).filename === "string"
        && sameEntry(this.#config.entryUrl, (reload as ReloadLike).filename)
      ) {
        matchesEntry = true;
        break;
      }
    }

    if (!matchesEntry) {
      this.#generation = { ...this.#generation, hmrSequence: this.#sequence, admitted: false };
      return;
    }

    let candidateSha256: string;
    try {
      candidateSha256 = digestSnapshot(snapshotSync(this.#config.files, "sourcePath"));
    } catch {
      this.#generation = { ...this.#generation, hmrSequence: this.#sequence, admitted: false };
      return;
    }

    this.#generation = {
      candidateId: null,
      candidateSha256,
      hmrSequence: this.#sequence,
      admitted: false,
      gitTree: this.#config.gitTree,
      dshVersion: this.#config.dshVersion,
      profile: this.#config.profile,
    };
  }
}

Object.defineProperty(CandidateCoordinator, "create", {
  configurable: false,
  value: CandidateCoordinator.create,
  writable: false,
});

function registerTools(ctx: Context, coordinator: CandidateCoordinator): void {
  ctx.tools.register(defineTool({
    name: "dal_candidate_prepare",
    description:
      "Copy the configured live plugin files into the fixed candidate staging directory. Edit only those staged copies; this operation does not touch the loaded plugin or trigger candidate HMR.",
    parameters: {
      candidate_id: {
        type: "string",
        required: true,
        description: "Identifier for this candidate, e.g. cand-tool-description-001.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string", required: true },
          baseline_sha256: { type: "string", required: true },
          staging_root: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `Prepared ${value.candidate_id} under ${value.staging_root}; baseline ${value.baseline_sha256}.` }],
    },
    async execute(args) {
      const candidateId = (args as { candidate_id: string }).candidate_id;
      const status = await coordinator.prepare(candidateId);
      return {
        candidate_id: status.preparedCandidateId!,
        baseline_sha256: status.sourceSha256,
        staging_root: status.stagingRoot,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "dal_candidate_status",
    description:
      "Read staged/source digests and the observed HMR event sequence. The sequence is diagnostic only: it does not prove activation readiness or runtime-closure identity.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prepared_candidate_id: { type: "string" },
          source_sha256: { type: "string", required: true },
          staged_sha256: { type: "string" },
          active_candidate_id: { type: "string" },
          active_candidate_sha256: { type: "string", required: true },
          hmr_sequence: { type: "integer", required: true },
          admitted: { type: "boolean", required: true },
          staging_root: { type: "string", required: true },
          git_tree: { type: "string", required: true },
          dsh_version: { type: "string", required: true },
          profile: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `Observed HMR sequence ${value.hmr_sequence}; admitted ${value.admitted}.` }],
    },
    async execute() {
      const status = await coordinator.status();
      return {
        ...(status.preparedCandidateId === undefined ? {} : { prepared_candidate_id: status.preparedCandidateId }),
        source_sha256: status.sourceSha256,
        ...(status.stagedSha256 === undefined ? {} : { staged_sha256: status.stagedSha256 }),
        ...(status.activeCandidateId === undefined ? {} : { active_candidate_id: status.activeCandidateId }),
        active_candidate_sha256: status.activeCandidateSha256,
        hmr_sequence: status.hmrSequence,
        admitted: status.admitted,
        staging_root: status.stagingRoot,
        git_tree: status.gitTree,
        dsh_version: status.dshVersion,
        profile: status.profile,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "dal_candidate_apply",
    description:
      "Report that HMR candidate application is quarantined. This tool never verifies approval, changes loaded files, or admits a candidate until DSH exposes runtime-closure identity and awaited activation readiness.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          quarantined: { type: "boolean", required: true },
        },
      },
      render: () => [{ type: "text", text: "HMR candidate application remains quarantined." }],
    },
    async execute() {
      await coordinator.applyPrepared();
      return { quarantined: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: "dal_candidate_reject",
    description:
      "Discard the prepared candidate record only when live source still matches its baseline. If live files drifted, fail without overwriting them.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_sha256: { type: "string", required: true },
          hmr_sequence: { type: "integer", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `Discarded the staged candidate record; live source remains ${value.source_sha256}.` }],
    },
    async execute() {
      const generation = await coordinator.reject();
      return {
        source_sha256: generation.candidateSha256,
        hmr_sequence: generation.hmrSequence,
      };
    },
  }));
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const coordinator = await CandidateCoordinator.create(ctx, config);
  registerTools(ctx, coordinator);
}
