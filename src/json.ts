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

/** RFC 8785 JSON Canonicalization Scheme for already-parsed I-JSON values. */
export function jcsCanonicalJson(value: unknown): string {
  assertIJson(value, "$");
  return canonicalJson(value);
}

/** Enforce the I-JSON duplicate-name prerequisite before JSON.parse loses it. */
export function assertIJsonText(rawText: string): void {
  let index = 0;

  function skipWhitespace(): void {
    while (/\s/.test(rawText[index] ?? "")) index += 1;
  }

  function parseString(): string {
    const start = index;
    index += 1;
    while (index < rawText.length) {
      const character = rawText[index];
      if (character === "\\") {
        index += rawText[index + 1] === "u" ? 6 : 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(rawText.slice(start, index)) as string;
      }
    }
    throw new DalError("INVALID_IJSON_VALUE", "I-JSON string is not terminated");
  }

  function parseValue(path: string): void {
    skipWhitespace();
    const character = rawText[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (rawText[index] === "}") {
        index += 1;
        return;
      }
      while (index < rawText.length) {
        skipWhitespace();
        if (rawText[index] !== '"') break;
        const key = parseString();
        if (keys.has(key)) {
          throw new DalError("INVALID_IJSON_VALUE", `I-JSON object contains duplicate key at ${path}/${escapeJsonPointer(key)}`);
        }
        keys.add(key);
        skipWhitespace();
        if (rawText[index] !== ":") break;
        index += 1;
        parseValue(`${path}/${escapeJsonPointer(key)}`);
        skipWhitespace();
        if (rawText[index] === "}") {
          index += 1;
          return;
        }
        if (rawText[index] !== ",") break;
        index += 1;
      }
    } else if (character === "[") {
      index += 1;
      skipWhitespace();
      if (rawText[index] === "]") {
        index += 1;
        return;
      }
      let item = 0;
      while (index < rawText.length) {
        parseValue(`${path}/${item}`);
        item += 1;
        skipWhitespace();
        if (rawText[index] === "]") {
          index += 1;
          return;
        }
        if (rawText[index] !== ",") break;
        index += 1;
      }
    } else if (character === '"') {
      parseString();
      return;
    } else {
      while (index < rawText.length && !/[\s,\]}]/.test(rawText[index]!)) index += 1;
      return;
    }
    throw new DalError("INVALID_IJSON_VALUE", `Invalid I-JSON structure at ${path}`);
  }

  parseValue("$");
  skipWhitespace();
  if (index !== rawText.length) {
    throw new DalError("INVALID_IJSON_VALUE", "I-JSON contains trailing content");
  }
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

function assertIJson(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DalError("INVALID_IJSON_VALUE", `I-JSON numbers must be finite at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertIJson(item, `${path}/${index}`));
    return;
  }
  if (typeof value !== "object") {
    throw new DalError("INVALID_IJSON_VALUE", `Unsupported I-JSON value type at ${path}: ${typeof value}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DalError("INVALID_IJSON_VALUE", `I-JSON objects must have a plain object prototype at ${path}`);
  }
  const object = value as Record<string, unknown>;
  if (Reflect.ownKeys(object).some((key) => typeof key === "symbol")) {
    throw new DalError("INVALID_IJSON_VALUE", `I-JSON objects cannot contain symbol keys at ${path}`);
  }
  for (const key of Object.keys(object)) {
    assertUnicodeScalarString(key, `${path}/<key>`);
    const child = object[key];
    if (child === undefined) {
      throw new DalError("INVALID_IJSON_VALUE", `Undefined I-JSON value at ${path}/${key}`);
    }
    assertIJson(child, `${path}/${key}`);
  }
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new DalError("INVALID_IJSON_VALUE", `I-JSON string contains an unpaired surrogate at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new DalError("INVALID_IJSON_VALUE", `I-JSON string contains an unpaired surrogate at ${path}`);
    }
  }
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
