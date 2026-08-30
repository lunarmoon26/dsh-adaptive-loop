import { DalError } from "./errors.js";
import { readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { ApprovalDecision, SensitiveAction } from "./types.js";

export interface ApprovalExpectation {
  action: SensitiveAction;
  scope: string;
  candidateSha256?: string;
  at?: Date;
}

const SCOPE_KINDS: Record<SensitiveAction, ApprovalDecision["scope"]["kind"]> = {
  change_shared_harness_config: "configuration",
  install_or_mount_plugin: "plugin",
  send_data_externally: "data_transfer",
  apply_optimization_candidate: "proposal",
};

export async function validateApprovalDecision(value: unknown): Promise<ApprovalDecision> {
  await assertSchema(SCHEMA_IDS.approval, value, "Approval decision");
  const decision = value as ApprovalDecision;
  const issues: string[] = [];

  if (decision.scope.sha256 !== sha256(decision.scope.value)) {
    issues.push("/scope/sha256 does not match /scope/value");
  }
  if (Date.parse(decision.decided_at) >= Date.parse(decision.expires_at)) {
    issues.push("/decided_at must be earlier than /expires_at");
  }
  if (decision.scope.kind !== SCOPE_KINDS[decision.action]) {
    issues.push(`/scope/kind must be ${SCOPE_KINDS[decision.action]} for ${decision.action}`);
  }
  if (decision.action !== "apply_optimization_candidate" && decision.candidate_sha256 !== null) {
    issues.push("/candidate_sha256 must be null unless action is apply_optimization_candidate");
  }
  if (issues.length > 0) {
    throw new DalError("APPROVAL_SEMANTIC_INVALID", "Approval decision violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(decision));
  assertNoPii(scanPii(decision));
  return decision;
}

export async function verifyApproval(
  value: unknown,
  expectation: ApprovalExpectation,
): Promise<ApprovalDecision> {
  const decision = await validateApprovalDecision(value);
  const at = expectation.at ?? new Date();
  const issues: string[] = [];

  if (decision.decision !== "approved") {
    issues.push("decision is not approved");
  }
  if (decision.action !== expectation.action) {
    issues.push(`action does not match ${expectation.action}`);
  }
  if (decision.scope.value !== expectation.scope || decision.scope.sha256 !== sha256(expectation.scope)) {
    issues.push("scope value or digest does not match exactly");
  }
  const atTime = at.getTime();
  if (Number.isNaN(atTime)) {
    issues.push("verification time is invalid");
  } else {
    if (atTime < Date.parse(decision.decided_at)) {
      issues.push("decision is not yet effective");
    }
    if (atTime >= Date.parse(decision.expires_at)) {
      issues.push("decision has expired");
    }
  }

  if (expectation.action === "apply_optimization_candidate") {
    if (expectation.candidateSha256 === undefined) {
      issues.push("candidate SHA-256 is required for candidate application");
    } else if (decision.candidate_sha256 !== expectation.candidateSha256) {
      issues.push("candidate SHA-256 does not match exactly");
    }
  }

  if (issues.length > 0) {
    throw new DalError("APPROVAL_DENIED", `Approval ${decision.decision_id} does not authorize the operation`, issues);
  }
  return decision;
}

export async function verifyApprovalFile(
  filePath: string,
  expectation: ApprovalExpectation,
): Promise<ApprovalDecision> {
  const { value, raw } = await readJsonFile<unknown>(filePath);
  assertNoSecrets(scanSecrets(value, raw.toString("utf8")));
  assertNoPii(scanPii(value, raw.toString("utf8")));
  return verifyApproval(value, expectation);
}
