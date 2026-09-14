import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface ApprovalConfig {
  dalWorktree?: string;
  approvalFile?: string;
  manifestFile?: string;
}

const execute = promisify(execFile);
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Verify actual package bytes and the real DAL approval at the OAuth operation. */
export async function verifyLoginApproval(config: ApprovalConfig): Promise<void> {
  if (!config.dalWorktree || !config.approvalFile || !config.manifestFile) {
    throw new Error("OAUTH_APPROVAL_REQUIRED");
  }
  const manifestBytes = await readFile(resolve(config.manifestFile));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    plugin?: string; authorization_key?: string; method?: string; files?: Record<string, string>;
  };
  if (manifest.plugin !== "@lunarmoon26/dal-codex-oauth"
      || manifest.authorization_key !== "llm-pi-ai/openai-codex" || manifest.method !== "oauth" || !manifest.files) {
    throw new Error("OAUTH_SCOPE_MISMATCH");
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const expected = ["package.json", "bootstrap.patch.yml",
    ...(await readdir(join(packageRoot, "lib"))).filter(name => name.endsWith(".js")).map(name => `lib/${name}`)].sort();
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) {
    throw new Error("OAUTH_PACKAGE_INVENTORY_MISMATCH");
  }
  for (const name of expected) {
    if (sha(await readFile(join(packageRoot, name))) !== manifest.files[name]) {
      throw new Error("OAUTH_PACKAGE_DRIFT");
    }
  }
  // Fixed verifier only, no shell or arbitrary command argument. Output is
  // intentionally captured, not forwarded to the login terminal or agent logs.
  await execute("pnpm", ["dal", "approval", "verify", resolve(config.approvalFile),
    "--action", "send_data_externally", "--scope", `codex-oauth-bootstrap-login:${sha(manifestBytes)}`],
  { cwd: resolve(config.dalWorktree), timeout: 15_000, maxBuffer: 1024 * 1024 });
}
