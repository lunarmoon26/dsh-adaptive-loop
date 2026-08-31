import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isNodeError, DalError } from "./errors.js";

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
