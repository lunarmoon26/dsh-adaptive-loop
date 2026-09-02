import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { RESET_ACKNOWLEDGE_TOKEN, resetExecute, resetStatus } from "../src/reset.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dal-reset-"));
}

async function fakeStoreFile(root: string, dir: string, name: string, content: string): Promise<void> {
  const directory = join(root, ".dal", dir);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function gitInit(root: string): Promise<string> {
  git(root, "init", "-q");
  git(root, "config", "user.email", "reset-test@example.com");
  git(root, "config", "user.name", "Reset Test");
  git(root, "commit", "--allow-empty", "-q", "-m", "init");
  return git(root, "rev-parse", "HEAD").trim();
}

describe("reset / rebaseline", () => {
  it("reports a dry-run status without mutating the stores", async () => {
    const root = await workspace();
    await fakeStoreFile(root, "store", "fb-example.json", "{}");
    const status = await resetStatus({ workspaceDir: root });
    expect(status.evidence_exists).toBe(true);
    expect(status.removed.store).toBe(1);
    expect(status.git.present).toBe(false);
    expect(status.ready).toBe(true);
    await expect(access(join(root, ".dal", "store", "fb-example.json"))).resolves.toBeUndefined();
  });

  it("refuses without the acknowledgement token and removes nothing", async () => {
    const root = await workspace();
    await fakeStoreFile(root, "store", "fb-example.json", "{}");
    await expect(
      resetExecute({ workspaceDir: root, reason: "cut a branch", acknowledge: "nope" }),
    ).rejects.toMatchObject({ code: "RESET_ACKNOWLEDGE_REQUIRED" });
    await expect(access(join(root, ".dal", "store", "fb-example.json"))).resolves.toBeUndefined();
  });

  it("rejects secret material in the reason", async () => {
    const root = await workspace();
    await expect(
      resetExecute({
        workspaceDir: root,
        reason: "token ghp_1234567890abcdefghij",
        acknowledge: RESET_ACKNOWLEDGE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "SECRET_DETECTED" });
    await expect(access(join(root, ".dal"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the stores, re-scaffolds them, and records a validated receipt", async () => {
    const root = await workspace();
    await fakeStoreFile(root, "store", "fb-example.json", "{}");
    await fakeStoreFile(root, "check", "score.json", "{}");
    const result = await resetExecute({
      workspaceDir: root,
      reason: "Rebaseline after branch cut.",
      actor: "operator-test",
      acknowledge: RESET_ACKNOWLEDGE_TOKEN,
    });
    expect(result.status).toBe("reset");
    expect(result.removed.store).toBe(1);
    expect(result.removed.other).toBe(1);
    expect(result.revision).toBeNull();
    await expect(access(join(root, ".dal", "store", "fb-example.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of ["outbox", "store", "runs", "clusters", "control-states", "resets"]) {
      await expect(access(join(root, ".dal", directory))).resolves.toBeUndefined();
    }
    const receipt = JSON.parse(
      await readFile(join(root, ".dal", "resets", `${result.reset_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt.action).toBe("reset");
    expect(receipt.reason).toBe("Rebaseline after branch cut.");
    expect(receipt.actor).toBe("operator-test");
    expect(receipt.stores_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.removed).toMatchObject({ total_files: 2, store: 1, other: 1 });
    expect(receipt.repository).toMatchObject({ dirty: false, revision: null });
  });

  it("blocks when tracked evidence has uncommitted changes", async () => {
    const root = await workspace();
    await gitInit(root);
    await fakeStoreFile(root, "store", "fb-uncommitted.json", "{}");
    await expect(
      resetExecute({ workspaceDir: root, reason: "cut", acknowledge: RESET_ACKNOWLEDGE_TOKEN }),
    ).rejects.toMatchObject({ code: "RESET_DIRTY" });
    await expect(access(join(root, ".dal", "store", "fb-uncommitted.json"))).resolves.toBeUndefined();
  });

  it("records the pre-reset revision in a clean git workspace", async () => {
    const root = await workspace();
    await gitInit(root);
    await fakeStoreFile(root, "store", "fb-committed.json", "{}");
    git(root, "add", ".dal");
    git(root, "commit", "-q", "-m", "evidence");
    const revision = git(root, "rev-parse", "HEAD").trim();
    const result = await resetExecute({ workspaceDir: root, reason: "cut", acknowledge: RESET_ACKNOWLEDGE_TOKEN });
    expect(result.revision).toBe(revision);
    const receipt = JSON.parse(
      await readFile(join(root, ".dal", "resets", `${result.reset_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt.repository).toMatchObject({ revision, dirty: false });
  });

  it("exposes the commands through the CLI", async () => {
    const root = await workspace();
    const noop = { stdout: (): void => undefined, stderr: (): void => undefined };
    expect(await runCli(["reset", "execute", "--workspace", root, "--reason", "nope"], noop)).toBe(1);
    expect(await runCli(["reset", "status", "--workspace", root], noop)).toBe(0);
  });
});
