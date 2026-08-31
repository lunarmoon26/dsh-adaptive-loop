import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateApprovalDecision, verifyApproval } from "./approval.js";
import { isNodeError, DalError } from "./errors.js";
import { canonicalJson, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";

export const USER_GLOBAL_INSTALL_ACTION = "change_shared_harness_config" as const;

const deploymentDirectory = fileURLToPath(new URL("../docs/deployment/", import.meta.url));
const skillSourcePath = join(deploymentDirectory, "end-task-feedback-global-SKILL.md");
const agentsSourcePath = join(deploymentDirectory, "user-global-AGENTS.md");

export interface UserGlobalInstallResult {
  status: "installed" | "idempotent";
  scope_digest: string;
  skill_path: string;
  agents_path: string;
  rollback: string[];
}

export interface UserGlobalInstallOptions {
  approvalPath: string;
  agentsHome?: string;
  dshHome?: string;
  now?: Date;
}

/**
 * The scope digest binds the decision to the exact template bytes this build
 * installs. Changing either template changes the digest and voids old decisions.
 */
export async function userGlobalInstallScopeDigest(): Promise<string> {
  const [skill, agents] = await Promise.all([readFile(skillSourcePath, "utf8"), readFile(agentsSourcePath, "utf8")]);
  return sha256(canonicalJson({ skill, agents }));
}

export async function installUserGlobal(options: UserGlobalInstallOptions): Promise<UserGlobalInstallResult> {
  const document = await readJsonFile<unknown>(options.approvalPath);
  assertNoSecrets(scanSecrets(document.value, document.raw.toString("utf8")));
  assertNoPii(scanPii(document.value, document.raw.toString("utf8")));
  const decision = await validateApprovalDecision(document.value);
  const scopeDigest = await userGlobalInstallScopeDigest();
  await verifyApproval(decision, {
    action: USER_GLOBAL_INSTALL_ACTION,
    scope: scopeDigest,
    at: options.now ?? new Date(),
  });

  const agentsHome = options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const skillPath = join(agentsHome, "skills", "end-task-feedback", "SKILL.md");
  const agentsPath = join(dshHome, "AGENTS.md");

  const [skill, agents] = await Promise.all([readFile(skillSourcePath, "utf8"), readFile(agentsSourcePath, "utf8")]);
  const skillState = await publishTemplateText(skillPath, skill);
  const agentsState = await publishTemplateText(agentsPath, agents);

  return {
    status: skillState === "idempotent" && agentsState === "idempotent" ? "idempotent" : "installed",
    scope_digest: scopeDigest,
    skill_path: skillPath,
    agents_path: agentsPath,
    rollback: [`rm -rf ${join(agentsHome, "skills", "end-task-feedback")}`, `rm -f ${agentsPath}`],
  };
}

async function publishTemplateText(path: string, content: string): Promise<"installed" | "idempotent"> {
  try {
    const existing = await readFile(path, "utf8");
    if (existing === content) {
      return "idempotent";
    }
    throw new DalError(
      "INSTALL_CONFLICT",
      `Install target already exists with different content: ${path}; resolve or remove it manually and retry`,
    );
  } catch (error) {
    if (error instanceof DalError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
    return "installed";
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
