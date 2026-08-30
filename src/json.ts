import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { isNodeError, DalError } from "./errors.js";

export interface JsonDocument<T> {
  value: T;
  raw: Buffer;
}

export async function readJsonFile<T>(filePath: string): Promise<JsonDocument<T>> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    const detail = isNodeError(error) && error.code === "ENOENT" ? "does not exist" : "could not be read";
    throw new DalError("FILE_READ_FAILED", `JSON file ${detail}: ${filePath}`);
  }

  try {
    return { value: JSON.parse(raw.toString("utf8")) as T, raw };
  } catch {
    throw new DalError("INVALID_JSON", `Invalid JSON: ${filePath}`);
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DalError("INVALID_JSON_VALUE", "JSON numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child === undefined) {
        throw new DalError("INVALID_JSON_VALUE", `Undefined JSON value at key ${key}`);
      }
      normalized[key] = normalizeJson(child);
    }
    return normalized;
  }
  throw new DalError("INVALID_JSON_VALUE", `Unsupported JSON value type: ${typeof value}`);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(prettyJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function publishJsonExclusive(filePath: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(prettyJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporary, filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function escapeJsonPointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") {
    return value;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }

  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
