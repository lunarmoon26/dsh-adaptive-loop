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
  /** Fixed approval decision path relative to workspaceRoot. */
  approvalFile?: string;
  /** Exact approval scope passed to `dal approval verify`. */
  approvalScope: string;
  /** Absolute Node launcher files for the DAL CLI, all outside workspaceRoot. */
  approvalCommand?: string[];
  /** Pinned DSH package version used by the workbench profile. */
  dshVersion: string;
  /** DSH profile identity used by the workbench. */
  profile: string;
  /** HMR admission and approval-command timeout. */
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
  baseline: Snapshot;
  baselineSha256: string;
}

interface PendingActivation {
  candidateId: string | null;
  candidateSha256: string;
  admitted: boolean;
  resolve(generation: CandidateGeneration): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ReloadLike {
  filename: string;
}

interface HmrEventContext {
  on(name: string, listener: (...args: unknown[]) => unknown): unknown;
}

interface ResolvedConfig {
  workspaceRoot: string;
  entryPath: string;
  entryUrl: string;
  files: FileTarget[];
  stagingRoot: string;
  stagingRootRelative: string;
  approvalFile: string;
  approvalScope: string;
  approvalCommand: ApprovalCommandFile[];
  timeoutMs: number;
  gitTree: string;
  dshVersion: string;
  profile: string;
}

interface ApprovalVerification {
  approvalFile: string;
  approvalScope: string;
  approvalCommand: string[];
  candidateSha256: string;
  workspaceRoot: string;
  timeoutMs: number;
}

interface ApprovalCommandFile {
  path: string;
  sha256: string;
}

type ApprovalVerifier = (verification: ApprovalVerification) => Promise<void>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    dalCandidate: CandidateCoordinator;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
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

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveApprovalCommand(
  configured: string[] | undefined,
  workspaceRoot: string,
): Promise<ApprovalCommandFile[]> {
  const command = configured ?? [fileURLToPath(new URL("../../../dist/cli.js", import.meta.url))];
  if (
    !Array.isArray(command)
    || command.length === 0
    || command.length > 4
    || command.some((path) => typeof path !== "string" || path === "" || path.length > 2048 || /[\0\r\n]/.test(path))
  ) {
    fail("CANDIDATE_CONFIG_INVALID", "approvalCommand must contain one to four absolute launcher files");
  }
  const resolved: ApprovalCommandFile[] = [];
  for (const [index, path] of command.entries()) {
    if (!isAbsolute(path)) {
      fail("CANDIDATE_CONFIG_INVALID", `approvalCommand[${index}] must be absolute`);
    }
    let canonical: string;
    let info;
    try {
      canonical = await realpath(path);
      info = await lstat(canonical);
    } catch (error) {
      fail("CANDIDATE_CONFIG_INVALID", `approvalCommand[${index}] must be an existing regular file`, error);
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      fail("CANDIDATE_CONFIG_INVALID", `approvalCommand[${index}] must resolve to a regular file`);
    }
    if (canonical === workspaceRoot || inside(workspaceRoot, canonical)) {
      fail("CANDIDATE_CONFIG_INVALID", `approvalCommand[${index}] must be outside workspaceRoot`);
    }
    resolved.push({ path: canonical, sha256: digestBytes(await readFile(canonical)) });
  }
  return resolved;
}

async function assertApprovalCommandStable(command: ApprovalCommandFile[]): Promise<void> {
  for (const file of command) {
    try {
      const canonical = await realpath(file.path);
      const info = await lstat(canonical);
      if (
        canonical !== file.path
        || !info.isFile()
        || info.isSymbolicLink()
        || digestBytes(await readFile(canonical)) !== file.sha256
      ) {
        fail("CANDIDATE_APPROVAL_COMMAND_DRIFT", "the pinned approval command changed after coordinator startup");
      }
    } catch (error) {
      if (error instanceof CandidateError) throw error;
      fail("CANDIDATE_APPROVAL_COMMAND_DRIFT", "the pinned approval command is no longer available", error);
    }
  }
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
  if (typeof config.approvalScope !== "string" || config.approvalScope === "") {
    fail("CANDIDATE_CONFIG_INVALID", "approvalScope is required");
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(config.dshVersion)) {
    fail("CANDIDATE_CONFIG_INVALID", "dshVersion must be a semantic version");
  }
  if (typeof config.profile !== "string" || config.profile.length === 0 || config.profile.length > 128 || /[\r\n]/.test(config.profile)) {
    fail("CANDIDATE_CONFIG_INVALID", "profile must be a non-empty single-line identity");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    fail("CANDIDATE_CONFIG_INVALID", "timeoutMs must be an integer from 100 through 120000");
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
  const approvalFileRelative = canonicalRelative(
    config.approvalFile ?? ".dal/outbox/dal-hmr-candidate-approval.json",
    "approvalFile",
  );
  if (!approvalFileRelative.startsWith(".dal/")) {
    fail("CANDIDATE_CONFIG_INVALID", "approvalFile must stay under .dal/");
  }
  const approvalFile = resolve(workspaceRoot, approvalFileRelative);
  if (approvalFile === stagingRoot || inside(stagingRoot, approvalFile)) {
    fail("CANDIDATE_CONFIG_INVALID", "approvalFile must not overlap stagingRoot");
  }
  const approvalCommand = await resolveApprovalCommand(config.approvalCommand, workspaceRoot);

  const files: FileTarget[] = [];
  for (const relativePath of relatives.sort()) {
    const sourcePath = resolve(workspaceRoot, relativePath);
    if (!inside(workspaceRoot, sourcePath) || sourcePath === stagingRoot || inside(stagingRoot, sourcePath)) {
      fail("CANDIDATE_CONFIG_INVALID", `${relativePath} overlaps the staging root`);
    }
    await assertRegularFile(sourcePath, workspaceRoot, relativePath);
    if (sourcePath === approvalFile) {
      fail("CANDIDATE_CONFIG_INVALID", `${relativePath} overlaps approvalFile`);
    }
    files.push({ relativePath, sourcePath, stagingPath: resolve(stagingRoot, relativePath) });
  }

  const entryPath = resolve(workspaceRoot, entry);
  const entryUrl = pathToFileURL(await realpath(entryPath)).href;
  return {
    workspaceRoot,
    entryPath,
    entryUrl,
    files,
    stagingRoot,
    stagingRootRelative,
    approvalFile,
    approvalScope: config.approvalScope,
    approvalCommand,
    timeoutMs,
    gitTree,
    dshVersion: config.dshVersion,
    profile: config.profile,
  };
}

async function verifyWithDalCli(verification: ApprovalVerification): Promise<void> {
  await new Promise<void>((resolveApproval, rejectApproval) => {
    execFile(
      process.execPath,
      [
        ...verification.approvalCommand,
        "approval",
        "verify",
        verification.approvalFile,
        "--action",
        "apply_optimization_candidate",
        "--scope",
        verification.approvalScope,
        "--candidate-sha256",
        verification.candidateSha256,
      ],
      {
        cwd: verification.workspaceRoot,
        timeout: verification.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error) => {
        if (error === null) resolveApproval();
        else rejectApproval(error);
      },
    );
  });
}

export class CandidateCoordinator extends Service {
  private sequence = 0;
  private generation: CandidateGeneration;
  private prepared: PreparedCandidate | undefined;
  private pending: PendingActivation | undefined;
  private busy = false;

  static async create(
    ctx: Context,
    config: Config,
    approvalVerifier: ApprovalVerifier = verifyWithDalCli,
  ): Promise<CandidateCoordinator> {
    const resolved = await resolveConfig(config);
    return new CandidateCoordinator(ctx, resolved, approvalVerifier);
  }

  private constructor(
    ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly approvalVerifier: ApprovalVerifier,
  ) {
    super(ctx, "dalCandidate");
    this.generation = {
      candidateId: null,
      candidateSha256: digestSnapshot(snapshotSync(config.files, "sourcePath")),
      hmrSequence: 0,
      admitted: false,
      gitTree: config.gitTree,
      dshVersion: config.dshVersion,
      profile: config.profile,
    };
    (ctx as unknown as HmrEventContext).on("hmr/reload", (reloads) => {
      this.observeReload(reloads);
    });
  }

  currentGeneration(): CandidateGeneration {
    return { ...this.generation };
  }

  async status(): Promise<CandidateStatus> {
    const sourceSha256 = digestSnapshot(await snapshot(this.config.files, "sourcePath", this.config.workspaceRoot));
    let stagedSha256: string | undefined;
    if (this.prepared !== undefined) {
      try {
        stagedSha256 = digestSnapshot(await snapshot(this.config.files, "stagingPath", this.config.workspaceRoot));
      } catch {
        stagedSha256 = undefined;
      }
    }
    return {
      ...(this.prepared === undefined ? {} : { preparedCandidateId: this.prepared.id }),
      sourceSha256,
      ...(stagedSha256 === undefined ? {} : { stagedSha256 }),
      ...(this.generation.candidateId === null ? {} : { activeCandidateId: this.generation.candidateId }),
      activeCandidateSha256: this.generation.candidateSha256,
      hmrSequence: this.generation.hmrSequence,
      admitted: this.generation.admitted,
      stagingRoot: this.config.stagingRootRelative,
      gitTree: this.config.gitTree,
      dshVersion: this.config.dshVersion,
      profile: this.config.profile,
    };
  }

  async prepare(candidateId: string): Promise<CandidateStatus> {
    return this.exclusive(async () => {
      if (!IDENTIFIER.test(candidateId) || candidateId.length < 3 || candidateId.length > 128) {
        fail("CANDIDATE_ID_INVALID", "candidate id must satisfy the DAL identifier contract");
      }
      if (this.generation.candidateId !== null) {
        fail("CANDIDATE_ACTIVE", "reject or promote the active candidate before preparing another");
      }
      const baseline = await snapshot(this.config.files, "sourcePath", this.config.workspaceRoot);
      for (const target of this.config.files) {
        await writeAtomic(this.config.workspaceRoot, target.stagingPath, baseline.get(target.relativePath)!);
      }
      this.prepared = { id: candidateId, baseline, baselineSha256: digestSnapshot(baseline) };
      return this.status();
    });
  }

  async applyPrepared(): Promise<CandidateGeneration> {
    return this.exclusive(async () => {
      const prepared = this.prepared;
      if (prepared === undefined) fail("CANDIDATE_NOT_PREPARED", "prepare a candidate before applying it");
      const candidate = await snapshot(this.config.files, "stagingPath", this.config.workspaceRoot);
      const candidateSha256 = digestSnapshot(candidate);
      if (candidateSha256 === prepared.baselineSha256) {
        fail("CANDIDATE_UNCHANGED", "the staged candidate is byte-identical to the baseline");
      }
      const liveSha256 = digestSnapshot(await snapshot(this.config.files, "sourcePath", this.config.workspaceRoot));
      if (liveSha256 !== prepared.baselineSha256) {
        fail("CANDIDATE_BASELINE_DRIFT", "live candidate files changed after staging; prepare again");
      }
      await this.verifyApproval(candidateSha256);

      try {
        const admitted = await this.activate(candidate, prepared.id, candidateSha256, true);
        if (!this.matchesCurrent(admitted)) {
          fail("CANDIDATE_GENERATION_MOVED", "runtime changed before candidate admission completed");
        }
        return admitted;
      } catch (error) {
        try {
          await this.activate(prepared.baseline, null, prepared.baselineSha256, false);
        } catch (rollbackError) {
          fail("CANDIDATE_ROLLBACK_FAILED", "candidate activation failed and the prior generation was not confirmed", rollbackError);
        }
        fail("CANDIDATE_NOT_ADMITTED", "candidate activation failed; the prior generation was restored", error);
      }
    });
  }

  async reject(): Promise<CandidateGeneration> {
    return this.exclusive(async () => {
      const prepared = this.prepared;
      if (prepared === undefined) fail("CANDIDATE_NOT_PREPARED", "there is no prepared candidate to reject");
      const liveSha256 = digestSnapshot(await snapshot(this.config.files, "sourcePath", this.config.workspaceRoot));
      if (liveSha256 === prepared.baselineSha256 && this.generation.candidateId === null) {
        this.prepared = undefined;
        return this.currentGeneration();
      }
      if (liveSha256 !== this.generation.candidateSha256) {
        fail("CANDIDATE_SOURCE_DRIFT", "live candidate files changed outside the admitted generation; refusing to overwrite them");
      }
      const restored = await this.activate(prepared.baseline, null, prepared.baselineSha256, false);
      this.prepared = undefined;
      return restored;
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) fail("CANDIDATE_BUSY", "another candidate operation is still active");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  private matchesCurrent(expected: CandidateGeneration): boolean {
    return this.generation.candidateId === expected.candidateId
      && this.generation.candidateSha256 === expected.candidateSha256
      && this.generation.hmrSequence === expected.hmrSequence
      && this.generation.admitted === expected.admitted;
  }

  private async activate(
    desired: Snapshot,
    candidateId: string | null,
    candidateSha256: string,
    admitted: boolean,
  ): Promise<CandidateGeneration> {
    if (this.pending !== undefined) fail("CANDIDATE_BUSY", "an HMR admission is already pending");
    const activation = new Promise<CandidateGeneration>((resolveActivation, rejectActivation) => {
      const timer = setTimeout(() => {
        if (this.pending?.candidateSha256 === candidateSha256) this.pending = undefined;
        rejectActivation(new CandidateError("CANDIDATE_HMR_TIMEOUT", "matching successful HMR reload was not observed"));
      }, this.config.timeoutMs);
      this.pending = {
        candidateId,
        candidateSha256,
        admitted,
        resolve: resolveActivation,
        reject: rejectActivation,
        timer,
      };
    });

    try {
      const orderedTargets = [
        ...this.config.files.filter((target) => target.sourcePath !== this.config.entryPath),
        ...this.config.files.filter((target) => target.sourcePath === this.config.entryPath),
      ];
      for (const target of orderedTargets) {
        await writeAtomic(this.config.workspaceRoot, target.sourcePath, desired.get(target.relativePath)!);
      }
    } catch (error) {
      this.cancelPending(error);
      throw error;
    }
    return activation;
  }

  private cancelPending(cause: unknown): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(new CandidateError("CANDIDATE_WRITE_FAILED", "failed to publish candidate bytes", { cause }));
  }

  private observeReload(value: unknown): void {
    if (!(value instanceof Map)) return;
    this.sequence += 1;
    let matchesEntry = false;
    for (const reload of value.values()) {
      if (
        typeof reload === "object"
        && reload !== null
        && typeof (reload as ReloadLike).filename === "string"
        && sameEntry(this.config.entryUrl, (reload as ReloadLike).filename)
      ) {
        matchesEntry = true;
        break;
      }
    }

    if (!matchesEntry) {
      this.generation = { ...this.generation, hmrSequence: this.sequence, admitted: false };
      this.rejectPendingReload("a successful HMR reload did not include the configured candidate entry");
      return;
    }

    let candidateSha256: string;
    try {
      candidateSha256 = digestSnapshot(snapshotSync(this.config.files, "sourcePath"));
    } catch {
      this.generation = { ...this.generation, hmrSequence: this.sequence, admitted: false };
      this.rejectPendingReload("the configured entry could not be read after a successful reload");
      return;
    }
    const pending = this.pending;
    if (pending !== undefined && pending.candidateSha256 === candidateSha256) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      this.generation = {
        candidateId: pending.candidateId,
        candidateSha256,
        hmrSequence: this.sequence,
        admitted: pending.admitted,
        gitTree: this.config.gitTree,
        dshVersion: this.config.dshVersion,
        profile: this.config.profile,
      };
      pending.resolve({ ...this.generation });
      return;
    }

    if (pending !== undefined) {
      this.rejectPendingReload("the configured entry reloaded with bytes that did not match the pending candidate");
    }

    this.generation = {
      candidateId: this.generation.candidateSha256 === candidateSha256 ? this.generation.candidateId : null,
      candidateSha256,
      hmrSequence: this.sequence,
      admitted: false,
      gitTree: this.config.gitTree,
      dshVersion: this.config.dshVersion,
      profile: this.config.profile,
    };
  }

  private async verifyApproval(candidateSha256: string): Promise<void> {
    await assertApprovalCommandStable(this.config.approvalCommand);
    await assertRegularFile(this.config.approvalFile, this.config.workspaceRoot, "approvalFile");
    try {
      await this.approvalVerifier({
        approvalFile: this.config.approvalFile,
        approvalScope: this.config.approvalScope,
        approvalCommand: this.config.approvalCommand.map((file) => file.path),
        candidateSha256,
        workspaceRoot: this.config.workspaceRoot,
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      fail("CANDIDATE_APPROVAL_DENIED", "exact candidate approval verification failed", error);
    }
    await assertApprovalCommandStable(this.config.approvalCommand);
  }

  private rejectPendingReload(message: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(new CandidateError("CANDIDATE_HMR_MISMATCH", message));
  }
}

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
      "Read the staged/source digests and current successful-HMR sequence. Use after editing staged files to obtain the exact candidate digest for human approval, and before starting a fresh evaluation session.",
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
      render: (_args, value) => [{ type: "text", text: `HMR sequence ${value.hmr_sequence}; candidate ${value.active_candidate_id ?? "none"}; admitted ${value.admitted}.` }],
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
      "Verify the configured exact apply_optimization_candidate decision for the current staged digest, copy the staged bytes into the watched plugin worktree, and wait for a successful matching dsh HMR reload. End this session after success; evaluation must use a fresh session.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string", required: true },
          candidate_sha256: { type: "string", required: true },
          hmr_sequence: { type: "integer", required: true },
          admitted: { type: "boolean", required: true },
          git_tree: { type: "string", required: true },
          dsh_version: { type: "string", required: true },
          profile: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `Admitted ${value.candidate_id} at HMR sequence ${value.hmr_sequence}. Start a fresh session for evaluation.` }],
    },
    async execute() {
      const generation = await coordinator.applyPrepared();
      return {
        candidate_id: generation.candidateId!,
        candidate_sha256: generation.candidateSha256,
        hmr_sequence: generation.hmrSequence,
        admitted: generation.admitted,
        git_tree: generation.gitTree,
        dsh_version: generation.dshVersion,
        profile: generation.profile,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "dal_candidate_reject",
    description:
      "Restore the exact pre-candidate plugin bytes and wait for dsh HMR to reactivate that prior generation. This is rollback only; it never promotes or commits a candidate.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          restored_sha256: { type: "string", required: true },
          hmr_sequence: { type: "integer", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `Restored prior generation ${value.restored_sha256} at HMR sequence ${value.hmr_sequence}.` }],
    },
    async execute() {
      const generation = await coordinator.reject();
      return {
        restored_sha256: generation.candidateSha256,
        hmr_sequence: generation.hmrSequence,
      };
    },
  }));
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const coordinator = await CandidateCoordinator.create(ctx, config);
  registerTools(ctx, coordinator);
}
