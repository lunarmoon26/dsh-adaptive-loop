import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyLoginApproval } from "../plugins/dal-codex-oauth/src/approval.js";
import type { ApprovalConfig } from "../plugins/dal-codex-oauth/src/approval.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), readdir: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: (fn: unknown) => {
  if (fn !== execFile) throw new Error("Unexpected promisified function");
  return mocks.execute;
} }));

// chg-codex-oauth-approval-tests-20260913: synthetic metadata/bytes only.
// No real profile, grant, credential, manifest or package artifact is read.
const secret = "TEST_ONLY_VERIFIER_SECRET";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../plugins/dal-codex-oauth");
const config = {
  dalWorktree: "/synthetic/dal worktree",
  approvalFile: "/synthetic/decision ; literal.json",
  manifestFile: "/synthetic/manifest.json",
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const artifacts = new Map([
    ["package.json", Buffer.from('{"name":"@lunarmoon26/dal-codex-oauth"}\n')],
    ["bootstrap.patch.yml", Buffer.from("synthetic: true\n")],
    ["lib/index.js", Buffer.from("// synthetic index\n")],
    ["lib/approval.js", Buffer.from("// synthetic approval\n")],
    ["lib/terminal.js", Buffer.from("// synthetic terminal\n")],
  ]);
  const manifest = {
    plugin: "@lunarmoon26/dal-codex-oauth",
    authorization_key: "llm-pi-ai/openai-codex",
    method: "oauth",
    files: Object.fromEntries([...artifacts].map(([name, bytes]) => [name, sha(bytes)])),
  };
  let manifestBytes: Buffer<ArrayBuffer>;
  const encode = () => { manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); };
  encode();
  vi.mocked(readdir).mockResolvedValue([
    "terminal.js", "index.js", "approval.js", "index.d.ts", "index.js.map",
  ] as never);
  vi.mocked(readFile).mockImplementation(async path => {
    if (String(path) === resolve(config.manifestFile)) return manifestBytes;
    for (const [name, bytes] of artifacts) if (String(path) === join(packageRoot, name)) return bytes;
    throw new Error("Unexpected synthetic read");
  });
  return { artifacts, manifest, encode, bytes: () => manifestBytes };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockResolvedValue({ stdout: secret, stderr: secret });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("verifyLoginApproval", () => {
  it.each([{}, { ...config, dalWorktree: undefined }, { ...config, approvalFile: undefined },
    { ...config, manifestFile: undefined }, { ...config, dalWorktree: "" },
    { ...config, approvalFile: "" }, { ...config, manifestFile: "" }])("requires complete config %j", async value => {
    await expect(verifyLoginApproval(value as ApprovalConfig)).rejects.toThrow("OAUTH_APPROVAL_REQUIRED");
    expect(readFile).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["plugin", "@other/plugin"], ["authorization_key", "llm-pi-ai/other"], ["method", "api-key"],
  ] as const)("rejects wrong %s before inspecting artifacts", async (key, value) => {
    const f = fixture();
    f.manifest[key] = value;
    f.encode();
    await expect(verifyLoginApproval(config)).rejects.toThrow("OAUTH_SCOPE_MISMATCH");
    expect(readFile).toHaveBeenCalledExactlyOnceWith(config.manifestFile);
    expect(readdir).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["package.json", "bootstrap.patch.yml", "lib/index.js", "lib/approval.js", "lib/terminal.js"])(
    "rejects incomplete inventory missing %s", async name => {
      const f = fixture();
      delete f.manifest.files[name];
      f.encode();
      await expect(verifyLoginApproval(config)).rejects.toThrow("OAUTH_PACKAGE_INVENTORY_MISMATCH");
      expect(readFile).toHaveBeenCalledOnce();
      expect(mocks.execute).not.toHaveBeenCalled();
    });

  it.each(["lib/extra.js", "lib/index.d.ts", "../outside.js", "/synthetic/outside.js"])(
    "rejects unexpected declared inventory %s", async name => {
      const f = fixture();
      f.manifest.files[name] = sha(Buffer.from("synthetic"));
      f.encode();
      await expect(verifyLoginApproval(config)).rejects.toThrow("OAUTH_PACKAGE_INVENTORY_MISMATCH");
      expect(readFile).toHaveBeenCalledOnce();
      expect(mocks.execute).not.toHaveBeenCalled();
    });

  it("rejects a newly discovered undeclared JS artifact", async () => {
    fixture();
    vi.mocked(readdir).mockResolvedValue(["index.js", "approval.js", "terminal.js", "new.js"] as never);
    await expect(verifyLoginApproval(config)).rejects.toThrow("OAUTH_PACKAGE_INVENTORY_MISMATCH");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["package.json", "bootstrap.patch.yml", "lib/index.js", "lib/approval.js", "lib/terminal.js"])(
    "rejects changed bytes in %s", async name => {
      const f = fixture();
      f.artifacts.set(name, Buffer.from("changed synthetic bytes"));
      await expect(verifyLoginApproval(config)).rejects.toThrow("OAUTH_PACKAGE_DRIFT");
      expect(mocks.execute).not.toHaveBeenCalled();
    });

  it("hashes exact manifest bytes and own package inventory, and captures fixed verifier output", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(verifyLoginApproval(config)).resolves.toBeUndefined();
    expect(readdir).toHaveBeenCalledExactlyOnceWith(join(packageRoot, "lib"));
    expect(vi.mocked(readFile).mock.calls).toEqual([
      [config.manifestFile], ...[...f.artifacts.keys()].sort().map(name => [join(packageRoot, name)]),
    ]);
    expect(sha(f.bytes())).not.toBe(sha(Buffer.from(JSON.stringify(f.manifest))));
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("pnpm", [
      "dal", "approval", "verify", config.approvalFile,
      "--action", "send_data_externally", "--scope", `codex-oauth-bootstrap-login:${sha(f.bytes())}`,
    ], { cwd: config.dalWorktree, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const options = mocks.execute.mock.calls[0]![2];
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("propagates verifier rejection to the caller without printing captured details", async () => {
    fixture();
    const failure = Object.assign(new Error(secret), { stdout: secret, stderr: secret, code: 1 });
    mocks.execute.mockRejectedValue(failure);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(verifyLoginApproval(config)).rejects.toBe(failure);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
