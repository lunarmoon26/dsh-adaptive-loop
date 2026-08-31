import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installUserGlobal, userGlobalInstallScopeDigest } from "../src/install.js";
import { sha256 } from "../src/json.js";

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeDecision(
  filePath: string,
  options: { scopeValue: string; decidedAt: string; expiresAt: string; action?: string },
): Promise<void> {
  const decision = {
    $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
    schema_version: "1.0.0",
    decision_id: "dec-install-test",
    request_id: "req-install-test",
    action: options.action ?? "change_shared_harness_config",
    scope: { kind: "configuration", value: options.scopeValue, sha256: sha256(options.scopeValue) },
    decision: "approved",
    reviewer: { kind: "human", id: "operator" },
    decided_at: options.decidedAt,
    expires_at: options.expiresAt,
    rationale: "Test decision for the user-global install path.",
    evidence: ["repo://docs/deployment/user-global-install.md"],
    candidate_sha256: null,
  };
  await writeFile(filePath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

describe("user-global install", () => {
  it("installs the skill and global AGENTS.md under an exact approved decision", async () => {
    const agentsHome = await tempHome("dal-install-agents-");
    const dshHome = await tempHome("dal-install-dsh-");
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    const scope = await userGlobalInstallScopeDigest();
    await writeDecision(decisionPath, {
      scopeValue: scope,
      decidedAt: "2026-08-29T17:00:00.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
    });

    const result = await installUserGlobal({
      approvalPath: decisionPath,
      agentsHome,
      dshHome,
      now: new Date("2026-08-29T18:00:00.000Z"),
    });
    expect(result.status).toBe("installed");
    expect(result.scope_digest).toBe(scope);
    expect(await readFile(join(agentsHome, "skills", "end-task-feedback", "SKILL.md"), "utf8")).toContain(
      "name: end-task-feedback",
    );
    expect(await readFile(join(dshHome, "AGENTS.md"), "utf8")).toContain("user-global agent instructions");
  });

  it("is idempotent when the exact content already exists", async () => {
    const agentsHome = await tempHome("dal-install-agents-");
    const dshHome = await tempHome("dal-install-dsh-");
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    const scope = await userGlobalInstallScopeDigest();
    await writeDecision(decisionPath, {
      scopeValue: scope,
      decidedAt: "2026-08-29T17:00:00.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
    });
    const options = {
      approvalPath: decisionPath,
      agentsHome,
      dshHome,
      now: new Date("2026-08-29T18:00:00.000Z"),
    };
    await installUserGlobal(options);
    const second = await installUserGlobal(options);
    expect(second.status).toBe("idempotent");
  });

  it("fails closed when the decision scope does not match the templates", async () => {
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    await writeDecision(decisionPath, {
      scopeValue: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      decidedAt: "2026-08-29T17:00:00.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
    });
    await expect(
      installUserGlobal({
        approvalPath: decisionPath,
        agentsHome: await tempHome("dal-install-agents-"),
        dshHome: await tempHome("dal-install-dsh-"),
        now: new Date("2026-08-29T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  });

  it("fails closed when the decision is expired", async () => {
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    await writeDecision(decisionPath, {
      scopeValue: await userGlobalInstallScopeDigest(),
      decidedAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-29T11:00:00.000Z",
    });
    await expect(
      installUserGlobal({
        approvalPath: decisionPath,
        agentsHome: await tempHome("dal-install-agents-"),
        dshHome: await tempHome("dal-install-dsh-"),
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
  });

  it("refuses to overwrite a target that exists with different content", async () => {
    const agentsHome = await tempHome("dal-install-agents-");
    const dshHome = await tempHome("dal-install-dsh-");
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    await writeDecision(decisionPath, {
      scopeValue: await userGlobalInstallScopeDigest(),
      decidedAt: "2026-08-29T17:00:00.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
    });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dshHome, { recursive: true }));
    await writeFile(join(dshHome, "AGENTS.md"), "someone else's instructions\n", "utf8");
    await expect(
      installUserGlobal({
        approvalPath: decisionPath,
        agentsHome,
        dshHome,
        now: new Date("2026-08-29T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "INSTALL_CONFLICT" });
  });

  it("rejects a decision for a different sensitive action", async () => {
    const decisionPath = join(await tempHome("dal-install-dec-"), "decision.json");
    await writeDecision(decisionPath, {
      scopeValue: await userGlobalInstallScopeDigest(),
      decidedAt: "2026-08-29T17:00:00.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
      action: "send_data_externally",
    });
    await expect(
      installUserGlobal({
        approvalPath: decisionPath,
        agentsHome: await tempHome("dal-install-agents-"),
        dshHome: await tempHome("dal-install-dsh-"),
        now: new Date("2026-08-29T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_SEMANTIC_INVALID" });
  });
});
