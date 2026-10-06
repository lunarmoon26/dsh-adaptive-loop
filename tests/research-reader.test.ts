import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepositoryFile } from "../src/repository.js";

describe("bounded regular research artifact reads", () => {
  let cwd: string;
  let directory: string;
  beforeEach(async () => {
    cwd = process.cwd();
    directory = await mkdtemp("/tmp/opencode/research-reader-");
    process.chdir(directory);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  });
  it("preserves binary bytes at the exact cap and rejects a smaller cap", async () => {
    const input = Buffer.from([0, 255, 1, 128]);
    await writeFile(join(directory, "cache.bin"), input);
    expect(await readRepositoryFile("repo://cache.bin", "Cache", 4)).toEqual(input);
    await expect(readRepositoryFile("repo://cache.bin", "Cache", 3)).rejects.toMatchObject({ code: "REPOSITORY_FILE_READ_FAILED" });
  });
  it("supports an empty file at a zero cap", async () => {
    await writeFile("empty.bin", Buffer.alloc(0));
    expect(await readRepositoryFile("repo://empty.bin", "Empty", 0)).toEqual(Buffer.alloc(0));
  });
  it.each([-1, 1.5, Infinity, NaN])("rejects invalid read limit %s", async limit => {
    await expect(readRepositoryFile("repo://absent.bin", "Invalid", limit)).rejects.toMatchObject({ code: "REPOSITORY_FILE_READ_FAILED" });
  });
});
