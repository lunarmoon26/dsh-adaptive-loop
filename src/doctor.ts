import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EVIDENCE_DIRECTORIES } from "./init.js";
import { userGlobalInstallScopeDigest } from "./install.js";
import { validateRunRecord } from "./runs.js";
import { loadPolicy } from "./schema.js";

/** Read-only installation diagnostics. Never launches DSH or reads credentials. */
export async function doctorWorkspace(directory = ".") {
  const root = resolve(directory);
  const checks: Array<{ name: string; status: "present" | "missing" | "invalid"; detail: string }> = [];
  for (const name of [...EVIDENCE_DIRECTORIES, "AGENTS.md", ".agents/skills/end-task-feedback/SKILL.md"]) {
    try {
      const info = await lstat(join(root, name));
      const valid = name.startsWith(".dal/") ? info.isDirectory() : info.isFile();
      checks.push({ name, status: valid ? "present" : "invalid", detail: valid ? "Present; activation is not inferred." : "Expected a regular file or directory." });
    } catch {
      checks.push({ name, status: "missing", detail: "Run dal setup or review the existing workspace integration." });
    }
  }
  // Exercise packaged runtime assets rather than merely checking a package manifest.
  await loadPolicy();
  const templateDigest = await userGlobalInstallScopeDigest();
  let finalRecords = 0;
  let invalidRecords = 0;
  let checkpoints = 0;
  let scanTruncated = false;
  if (checks.find((check) => check.name === ".dal/runs")?.status === "present") {
    const files = (await readdir(join(root, ".dal/runs"))).filter((name) => name.endsWith(".json")).sort();
    scanTruncated = files.length > 1000;
    for (const name of files.slice(0, 1000)) {
      try {
        const path = join(root, ".dal/runs", name);
        const info = await lstat(path);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Unsupported record");
        const record = await validateRunRecord(JSON.parse(await readFile(path, "utf8")));
        if (record.record_stage === "final") finalRecords += 1;
        if (record.record_stage === "checkpoint") checkpoints += 1;
      } catch {
        invalidRecords += 1;
      }
    }
  }
  return {
    workspace: root,
    scaffold_ready: checks.every((check) => check.status === "present"),
    automatic_loop_ready: false,
    text_campaign_available: true,
    checks,
    packaged_assets: { status: "valid", install_scope_sha256: templateDigest },
    recording: { valid_final_records: finalRecords, checkpoints, invalid_records: invalidRecords, scan_truncated: scanTruncated },
    subscription_auth: "not_probed",
    runtime_attestation: "not_verified",
    independent_grader: "not_verified",
    blockers: ["TEXT_CAMPAIGN_NOT_CONFIGURED", "GENERAL_PLUGIN_ACTIVATION_UNAVAILABLE"],
    next_steps: [
      "Review workspace instructions if AGENTS.md already existed; file presence does not prove integration.",
      "Use exact approved DSH setup and native OAuth flows for recording; doctor never starts a session.",
      "Qualify an independent grader and runtime before making improvement claims.",
    ],
  };
}
