import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isNodeError, DalError } from "./errors.js";
import type { JsonDocument } from "./json.js";

const REPOSITORY_SCHEME = "repo://";

export function repositoryUriPath(uri: string): string | undefined {
  if (!uri.startsWith(REPOSITORY_SCHEME)) {
    return undefined;
  }
  const encoded = uri.slice(REPOSITORY_SCHEME.length);
  if (encoded.length === 0 || encoded.startsWith("/") || encoded.includes("\\") || /[?#]/.test(encoded)) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (decoded !== encoded || decoded.includes("\\") || decoded.includes("\0")) {
    return undefined;
  }

  const segments = decoded.split("/");
  if (segments.at(-1) === "") {
    segments.pop();
  }
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

export function repositoryUriWithin(uri: string, rootUri: string): boolean {
  const path = repositoryUriPath(uri);
  const root = repositoryUriPath(rootUri);
  return path !== undefined && root !== undefined && (path === root || path.startsWith(`${root}/`));
}

export function resolveRepositoryUri(uri: string, label: string): string {
  const localPath = repositoryUriPath(uri);
  if (localPath === undefined) {
    throw new DalError("REPOSITORY_URI_DENIED", `${label} is not a canonical repository URI`);
  }
  const path = resolve(process.cwd(), ...localPath.split("/"));
  const fromRoot = relative(process.cwd(), path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DalError("REPOSITORY_URI_DENIED", `${label} escapes the repository root`);
  }
  return path;
}

export function repositoryPathUri(filePath: string, label: string): string {
  const path = resolve(process.cwd(), filePath);
  const fromRoot = relative(process.cwd(), path);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DalError("REPOSITORY_URI_DENIED", `${label} is not a repository file path`);
  }
  const uri = `${REPOSITORY_SCHEME}${fromRoot.split(/[/\\]/).join("/")}`;
  if (repositoryUriPath(uri) === undefined) {
    throw new DalError("REPOSITORY_URI_DENIED", `${label} cannot be represented as a canonical repository URI`);
  }
  return uri;
}

/** Read one repository JSON file through a checked descriptor, never a followed final symlink. */
export async function readRepositoryJsonFile<T>(uri: string, label: string): Promise<JsonDocument<T>> {
  const path = resolveRepositoryUri(uri, label);
  const root = await realpath(process.cwd());
  if (
    !Number.isInteger(constants.O_NOFOLLOW)
    || constants.O_NOFOLLOW === 0
    || !Number.isInteger(constants.O_NONBLOCK)
    || constants.O_NONBLOCK === 0
  ) {
    throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} requires native safe file-open support`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} could not be opened safely`);
  }

  let raw: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} is not a regular file`);
    }
    const resolvedPath = await realpath(path);
    const fromRoot = relative(root, resolvedPath);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new DalError("REPOSITORY_URI_DENIED", `${label} resolves outside the repository root`);
    }
    const resolved = await stat(resolvedPath, { bigint: true });
    if (opened.dev !== resolved.dev || opened.ino !== resolved.ino) {
      throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} changed while it was opened`);
    }
    raw = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    if (
      opened.dev !== completed.dev
      || opened.ino !== completed.ino
      || opened.size !== completed.size
      || opened.mtimeNs !== completed.mtimeNs
      || opened.ctimeNs !== completed.ctimeNs
    ) {
      throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} changed while it was read`);
    }
  } catch (error) {
    if (error instanceof DalError) throw error;
    throw new DalError("REPOSITORY_FILE_READ_FAILED", `${label} could not be read safely`);
  } finally {
    await handle.close();
  }

  try {
    return { value: JSON.parse(raw.toString("utf8")) as T, raw };
  } catch {
    throw new DalError("INVALID_JSON", `${label} is not valid JSON`);
  }
}

export function resolveDedicatedRepositoryWritePath(
  filePath: string,
  rootUri: string,
): { destination: string; root: string } {
  const root = resolveRepositoryUri(rootUri, "Dedicated write root");
  const destination = resolve(process.cwd(), filePath);
  const fromRoot = relative(root, destination);
  if (
    fromRoot === "" ||
    fromRoot.startsWith("..") ||
    isAbsolute(fromRoot) ||
    fromRoot.includes("/") ||
    fromRoot.includes("\\")
  ) {
    throw new DalError("WRITE_PATH_DENIED", "Output must be a direct file below the dedicated proposal root");
  }
  return { destination, root };
}

export async function prepareSafeRepositoryDirectory(path: string): Promise<void> {
  await assertNoSymlinkTraversal(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(path);
}

export async function assertNoSymlinkTraversal(
  destination: string,
  code = "WRITE_PATH_DENIED",
  label = "Output",
): Promise<void> {
  const fromRoot = relative(process.cwd(), destination);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DalError(code, `${label} escapes the repository root`);
  }

  let current = process.cwd();
  for (const [index, segment] of fromRoot.split(/[/\\]/).entries()) {
    current = resolve(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new DalError(code, `${label} traverses a symbolic link at segment ${index + 1}`);
      }
      if (index < fromRoot.split(/[/\\]/).length - 1 && !metadata.isDirectory()) {
        throw new DalError(code, `${label} traverses a non-directory at segment ${index + 1}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
