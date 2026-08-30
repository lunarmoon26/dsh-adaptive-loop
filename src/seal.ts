import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { isNodeError, DalError } from "./errors.js";
import { prettyJson, readJsonFile, sha256 } from "./json.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";

export const SEAL_PROTOCOL = "rdl-seal-v1" as const;

export interface SealCommitment {
  $schema: string;
  schema_version: "1.0.0";
  seal_id: string;
  protocol_version: "rdl-seal-v1";
  created_at: string;
  case_count: number;
  observed_count: number;
  holdout_count: number;
  dataset_digest: string;
  seed_commitment: string;
}

export interface SealReveal {
  $schema: string;
  schema_version: "1.0.0";
  seal_id: string;
  candidate_id: string;
  revealed_at: string;
  holdout_cases: Array<{ case_id: string; sha256: string }>;
}

export interface SealInitResult {
  status: "sealed";
  seal_id: string;
  commitment: SealCommitment;
  observed_cases: string[];
  holdout_handles: string[];
  path: string;
}

export interface SealVerifyResult {
  status: "valid";
  seal_id: string;
  case_count: number;
  dataset_digest: string;
  locked: boolean;
  revealed: boolean;
}

export interface SealRevealResult {
  status: "revealed";
  seal_id: string;
  candidate_id: string;
  holdout_cases: Array<{ case_id: string; sha256: string }>;
  path: string;
}

export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) {
    throw new DalError("SEAL_INVALID", "A seal requires at least one case");
  }
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      next.push(right === undefined ? left : sha256(`node:${left}:${right}`));
    }
    level = next;
  }
  return level[0]!;
}

function caseLeaf(caseId: string, digest: string): string {
  return sha256(`case:${caseId}:${digest}`);
}

function seedCommitment(seed: Buffer, datasetDigest: string): string {
  return sha256(`${seed.toString("hex")}:${datasetDigest}:${SEAL_PROTOCOL}`);
}

function hmacDigest(seed: Buffer, value: string): string {
  return createHash("sha256").update(seed).update(value).digest("hex");
}

async function readCases(casesDir: string): Promise<Map<string, string>> {
  let names: string[];
  try {
    names = (await readdir(casesDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new DalError("SEAL_CASES_MISSING", `Case directory is not readable: ${casesDir}`);
  }
  if (names.length < 2) {
    throw new DalError("SEAL_INVALID", "A seal requires at least two case files");
  }
  const cases = new Map<string, string>();
  for (const name of names) {
    const document = await readJsonFile<unknown>(resolve(casesDir, name));
    const caseId = (document.value as { task_id?: unknown }).task_id;
    if (typeof caseId !== "string" || caseId.length === 0) {
      throw new DalError("SEAL_INVALID", `Case file has no task_id: ${name}`);
    }
    cases.set(caseId, sha256(document.raw.toString("utf8")));
  }
  return cases;
}

function splitHoldout(cases: Map<string, string>, seed: Buffer, holdoutCount: number): string[] {
  const ranked = [...cases.keys()].sort((left, right) => hmacDigest(seed, left).localeCompare(hmacDigest(seed, right)));
  return ranked.slice(0, holdoutCount).sort();
}

async function publishSealed(path: string, content: string): Promise<void> {
  const { mkdir: makeDir, open, rename, unlink } = await import("node:fs/promises");
  await makeDir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertPrivatePermissions(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.isDirectory() && (info.mode & 0o077) !== 0) {
      throw new DalError("SEAL_INSECURE", `${label} is group/world-accessible; the holdout boundary requires private permissions (0700)`);
    }
  } catch (error) {
    if (error instanceof DalError) {
      throw error;
    }
    throw new DalError("SEAL_INSECURE", `${label} cannot be inspected: ${path}`);
  }
}

export async function sealInit(options: {
  casesDir: string;
  outputDir: string;
  holdoutCount?: number;
  holdoutCasesDir?: string;
}): Promise<SealInitResult> {
  const output = resolve(process.cwd(), options.outputDir);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lockPath = resolve(output, "lock");
  const commitmentPath = resolve(output, "commitment.json");
  const sealedManifestPath = resolve(output, "sealed-manifest.json");
  const observedManifestPath = resolve(output, "observed-manifest.json");
  const revealPath = resolve(output, "reveal.json");
  if ((await exists(lockPath)) || (await exists(commitmentPath)) || (await exists(revealPath))) {
    throw new DalError("SEAL_LOCKED", `Seal already exists at ${output}; a seal is one-shot and cannot be re-initialized`);
  }

  const seed = randomBytes(32);
  const holdoutSource = options.holdoutCasesDir;
  const cases = await readCases(resolve(process.cwd(), options.casesDir));
  let holdout: string[];
  let allCases: Map<string, string>;

  if (holdoutSource !== undefined) {
    const holdoutDir = resolve(process.cwd(), holdoutSource);
    await assertPrivatePermissions(holdoutDir, "Holdout case directory");
    const holdoutCases = await readCases(holdoutDir);
    const overlap = [...holdoutCases.keys()].filter((caseId) => cases.has(caseId));
    if (overlap.length > 0) {
      throw new DalError("SEAL_INVALID", `Holdout and observed case sets overlap: ${overlap.join(", ")}`);
    }
    holdout = [...holdoutCases.keys()].sort();
    allCases = new Map([...cases, ...holdoutCases]);
    if (options.holdoutCount !== undefined && options.holdoutCount !== holdout.length) {
      throw new DalError("SEAL_INVALID", "--holdout conflicts with the holdout case directory; drop it and let the directory decide");
    }
  } else {
    const holdoutCount = options.holdoutCount ?? Math.max(1, Math.floor(cases.size / 3));
    if (holdoutCount < 1 || holdoutCount >= cases.size) {
      throw new DalError("SEAL_INVALID", `Holdout count ${holdoutCount} must be between 1 and ${cases.size - 1}`);
    }
    holdout = splitHoldout(cases, seed, holdoutCount);
    allCases = cases;
  }
  const observed = [...allCases.keys()].filter((caseId) => !holdout.includes(caseId)).sort();
  const datasetDigest = merkleRoot([...allCases.entries()].map(([caseId, digest]) => caseLeaf(caseId, digest)));

  const commitment: SealCommitment = {
    $schema: SCHEMA_IDS.sealCommitment,
    schema_version: "1.0.0",
    seal_id: `seal-${randomUUID()}`,
    protocol_version: SEAL_PROTOCOL,
    created_at: new Date().toISOString(),
    case_count: allCases.size,
    observed_count: observed.length,
    holdout_count: holdout.length,
    dataset_digest: datasetDigest,
    seed_commitment: seedCommitment(seed, datasetDigest),
  };
  await assertSchema(SCHEMA_IDS.sealCommitment, commitment, "Seal commitment");

  await publishSealed(commitmentPath, prettyJson(commitment));
  await publishSealed(
    sealedManifestPath,
    prettyJson({ seal_id: commitment.seal_id, holdout_cases: holdout.map((caseId) => ({ case_id: caseId, sha256: allCases.get(caseId) })) }),
  );
  await publishSealed(
    observedManifestPath,
    prettyJson({ seal_id: commitment.seal_id, observed_cases: observed.map((caseId) => ({ case_id: caseId, sha256: allCases.get(caseId) })) }),
  );
  await publishSealed(lockPath, `${commitment.seal_id}\n`);
  await chmod(output, 0o700).catch(() => undefined);
  await assertPrivatePermissions(output, "Seal directory");

  return {
    status: "sealed",
    seal_id: commitment.seal_id,
    commitment,
    observed_cases: observed,
    holdout_handles: holdout.map((caseId) => `seal-handle-${hmacDigest(seed, caseId).slice(0, 16)}`),
    path: output,
  };
}

export async function sealVerify(options: {
  sealedDir: string;
  casesDir: string;
  holdoutCasesDir?: string;
}): Promise<SealVerifyResult> {
  const output = resolve(process.cwd(), options.sealedDir);
  await assertPrivatePermissions(output, "Seal directory");
  const commitmentPath = resolve(output, "commitment.json");
  const lockPath = resolve(output, "lock");
  const revealPath = resolve(output, "reveal.json");
  if (!(await exists(commitmentPath))) {
    throw new DalError("SEAL_MISSING", `Seal commitment does not exist: ${commitmentPath}`);
  }
  const document = await readJsonFile<unknown>(commitmentPath);
  await assertSchema(SCHEMA_IDS.sealCommitment, document.value, "Seal commitment");
  const commitment = document.value as SealCommitment;

  const cases = await readCases(resolve(process.cwd(), options.casesDir));
  const allCases = new Map(cases);
  if (options.holdoutCasesDir !== undefined) {
    const holdoutDir = resolve(process.cwd(), options.holdoutCasesDir);
    await assertPrivatePermissions(holdoutDir, "Holdout case directory");
    const manifestDocument = await readJsonFile<{ holdout_cases: SealReveal["holdout_cases"] }>(
      resolve(output, "sealed-manifest.json"),
    );
    for (const entry of manifestDocument.value.holdout_cases) {
      const actual = await readCases(holdoutDir).then((map) => map.get(entry.case_id));
      if (actual !== entry.sha256) {
        throw new DalError("SEAL_DRIFT", `Holdout case ${entry.case_id} drifted from the sealed manifest`);
      }
      allCases.set(entry.case_id, entry.sha256);
    }
  }
  if (allCases.size !== commitment.case_count) {
    throw new DalError("SEAL_DRIFT", "Case count drifted from the commitment");
  }
  const datasetDigest = merkleRoot([...allCases.entries()].map(([caseId, digest]) => caseLeaf(caseId, digest)));
  if (datasetDigest !== commitment.dataset_digest) {
    throw new DalError("SEAL_DRIFT", "A case changed after sealing: the Merkle root does not match the commitment");
  }
  if (commitment.protocol_version !== SEAL_PROTOCOL) {
    throw new DalError("SEAL_INVALID", `Unknown seal protocol: ${commitment.protocol_version}`);
  }

  return {
    status: "valid",
    seal_id: commitment.seal_id,
    case_count: commitment.case_count,
    dataset_digest: datasetDigest,
    locked: await exists(lockPath),
    revealed: await exists(revealPath),
  };
}

export async function sealReveal(options: { sealedDir: string; candidateId: string }): Promise<SealRevealResult> {
  const output = resolve(process.cwd(), options.sealedDir);
  const commitmentPath = resolve(output, "commitment.json");
  const sealedManifestPath = resolve(output, "sealed-manifest.json");
  const revealPath = resolve(output, "reveal.json");
  if (!(await exists(commitmentPath))) {
    throw new DalError("SEAL_MISSING", `Seal commitment does not exist: ${commitmentPath}`);
  }
  if (await exists(revealPath)) {
    throw new DalError("SEAL_REVEALED", "The sealed holdout was already revealed; a reveal is one-shot");
  }
  const commitmentDocument = await readJsonFile<unknown>(commitmentPath);
  await assertSchema(SCHEMA_IDS.sealCommitment, commitmentDocument.value, "Seal commitment");
  const commitment = commitmentDocument.value as SealCommitment;

  const manifestDocument = await readJsonFile<{ holdout_cases: SealReveal["holdout_cases"] }>(sealedManifestPath);
  const reveal: SealReveal = {
    $schema: SCHEMA_IDS.sealReveal,
    schema_version: "1.0.0",
    seal_id: commitment.seal_id,
    candidate_id: options.candidateId,
    revealed_at: new Date().toISOString(),
    holdout_cases: manifestDocument.value.holdout_cases,
  };
  await assertSchema(SCHEMA_IDS.sealReveal, reveal, "Seal reveal");
  if (reveal.holdout_cases.length !== commitment.holdout_count) {
    throw new DalError("SEAL_INVALID", "Sealed manifest does not match the committed holdout count");
  }

  const published = await (async () => {
    const { mkdir: makeDir, open, link, unlink } = await import("node:fs/promises");
    await makeDir(output, { recursive: true, mode: 0o700 });
    const temporary = `${revealPath}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(prettyJson(reveal), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, revealPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return false;
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  })();
  if (!published) {
    throw new DalError("SEAL_REVEALED", "The sealed holdout was already revealed; a reveal is one-shot");
  }

  return {
    status: "revealed",
    seal_id: commitment.seal_id,
    candidate_id: options.candidateId,
    holdout_cases: reveal.holdout_cases,
    path: revealPath,
  };
}
