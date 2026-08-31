import { AsyncLocalStorage } from "node:async_hooks";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { validateApprovalDecision, verifyApproval } from "./approval.js";
import { isNodeError, DalError } from "./errors.js";
import { validateEvaluationScorecard } from "./evaluation-contract.js";
import { canonicalJson, publishJsonExclusive, readJsonFile, sha256 } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { repositoryUriPath, repositoryUriWithin } from "./repository.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type {
  ApprovalDecision,
  EvaluationScorecard,
  GuardrailAction,
  GuardrailDecision,
  GuardrailEffect,
  Policy,
  SensitiveAction,
} from "./types.js";

interface RuleResult {
  id: string;
  effect: GuardrailEffect;
  summary: string;
}

export interface GuardrailRecordResult {
  status: "stored" | "idempotent";
  path: string;
  decision: GuardrailDecision;
}

const SENSITIVE_CAPABILITIES: Partial<Record<GuardrailAction["capability"], SensitiveAction>> = {
  network_access: "send_data_externally",
  plugin_management: "install_or_mount_plugin",
  shared_configuration: "change_shared_harness_config",
  candidate_application: "apply_optimization_candidate",
};
const quarantineValidationContext = new AsyncLocalStorage<ReadonlySet<string>>();

export async function validateGuardrailAction(
  value: unknown,
  rawText?: string,
): Promise<GuardrailAction> {
  await assertSchema(SCHEMA_IDS.guardrailAction, value, "Guardrail action request");
  const action = value as GuardrailAction;
  const issues: string[] = [];
  const artifactFields = [action.target.artifact_kind, action.target.artifact_id, action.target.sha256];
  const presentArtifactFields = artifactFields.filter((field) => field !== null).length;

  if (presentArtifactFields !== 0 && presentArtifactFields !== artifactFields.length) {
    issues.push("/target artifact_kind, artifact_id, and sha256 must be supplied together");
  }
  if (action.data.contains_personal_data && !action.data.redacted) {
    issues.push("/data/redacted must be true when the source contains personal data");
  }
  if (action.capability === "candidate_application" && action.target.artifact_kind !== "optimizer_proposal") {
    issues.push("/target/artifact_kind must be optimizer_proposal for candidate_application");
  }
  if (action.capability === "plugin_management" && action.target.artifact_kind !== "plugin") {
    issues.push("/target/artifact_kind must be plugin for plugin_management");
  }
  if (issues.length > 0) {
    throw new DalError("GUARDRAIL_ACTION_INVALID", "Guardrail action violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(action, rawText));
  assertNoPii(scanPii(action, rawText));
  return action;
}

export async function evaluateGuardrailAction(
  value: unknown,
  approval?: ApprovalDecision,
  now = new Date(),
  suppliedPolicy?: Policy,
): Promise<GuardrailDecision> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  const action = await validateGuardrailAction(value);
  const rules: RuleResult[] = [];

  checkBudget(action, policy, rules);
  checkToolAndBoundary(action, policy, rules);
  rules.push(...(await checkQuarantine(action, policy)));

  if (policy.denied_capabilities.includes(action.capability)) {
    const sensitiveAction = SENSITIVE_CAPABILITIES[action.capability];
    if (sensitiveAction === undefined) {
      rules.push({
        id: "capability-denied",
        effect: "denied",
        summary: `Capability ${action.capability} is denied by v0 policy`,
      });
    } else {
      const approved = await approvalMatches(action, sensitiveAction, approval, now);
      if (!approved) {
        rules.push({
          id: "approval-required",
          effect: "requires_human_approval",
          summary: "A separate exact human approval is required",
        });
      } else {
        rules.push({
          id: "approval-verified",
          effect: "allowed",
          summary: "The supplied human approval matches the exact action and scope",
        });
        rules.push({
          id: "v0-executor-disabled",
          effect: "denied",
          summary: "v0 records policy decisions but implements no sensitive-action executor",
        });
      }
    }
  } else if (!policy.allowed_capabilities.includes(action.capability)) {
    rules.push({ id: "capability-unclassified", effect: "denied", summary: "Capability is not classified by policy" });
  } else {
    rules.push({ id: "capability-allowed", effect: "allowed", summary: "Capability is in the local v0 allowlist" });
  }

  if (action.approval_ref !== null && SENSITIVE_CAPABILITIES[action.capability] === undefined) {
    rules.push({
      id: "unexpected-approval",
      effect: "denied",
      summary: "An approval reference cannot broaden a non-sensitive request",
    });
  }

  const effect = overallEffect(rules);
  const decision: GuardrailDecision = {
    $schema: SCHEMA_IDS.guardrailDecision,
    storage_version: "1.0.0",
    decision_id: `gdec-${action.action_id.slice(4)}`,
    evaluated_at: now.toISOString(),
    effect,
    request_sha256: sha256(canonicalJson(action)),
    policy_sha256: sha256(canonicalJson(policy)),
    policy_version: policy.schema_version,
    secret_ruleset_version: policy.secret_ruleset_version,
    pii_ruleset_version: policy.pii_ruleset_version,
    evaluator: "rdl-deterministic-policy-v1",
    matched_rules: rules,
    approval_ref: approval?.decision_id ?? null,
    approval_sha256: approval === undefined ? null : sha256(canonicalJson(approval)),
    request: action,
  };
  await assertSchema(SCHEMA_IDS.guardrailDecision, decision, "Guardrail decision");
  return decision;
}

export async function recordGuardrailDecision(
  actionPath: string,
  approvalPath?: string,
  requestedStore?: string,
): Promise<GuardrailRecordResult> {
  const policy = await loadPolicy();
  const actionDocument = await readJsonFile<unknown>(actionPath);
  const action = await validateGuardrailAction(actionDocument.value, actionDocument.raw.toString("utf8"));
  let approval: ApprovalDecision | undefined;
  if (approvalPath !== undefined) {
    const approvalDocument = await readJsonFile<unknown>(approvalPath);
    assertNoSecrets(scanSecrets(approvalDocument.value, approvalDocument.raw.toString("utf8")));
    assertNoPii(scanPii(approvalDocument.value, approvalDocument.raw.toString("utf8")));
    approval = await validateApprovalDecision(approvalDocument.value);
  }

  const store = resolve(process.cwd(), requestedStore ?? policy.default_guardrail_audit_store);
  const destination = resolve(store, `${action.action_id}.json`);
  const existing = await readExistingDecision(destination);
  const requestDigest = sha256(canonicalJson(action));
  const policyDigest = sha256(canonicalJson(policy));
  if (existing !== undefined) {
    if (existing.request_sha256 === requestDigest && existing.policy_sha256 === policyDigest) {
      const current = await evaluateGuardrailAction(action, approval, new Date(), policy);
      if (sameDecisionState(existing, current)) {
        return { status: "idempotent", path: destination, decision: existing };
      }
      throw new DalError(
        "GUARDRAIL_DECISION_STALE",
        `Action ID ${action.action_id} has an immutable decision whose dynamic prerequisites changed; use a new action ID`,
      );
    }
    throw new DalError("GUARDRAIL_ID_CONFLICT", `Action ID ${action.action_id} already has a different audit record`);
  }

  await enforceRateLimit(store, policy);
  const decision = await evaluateGuardrailAction(action, approval, new Date(), policy);
  const published = await publishJsonExclusive(destination, decision);
  if (!published) {
    const raced = await readExistingDecision(destination);
    if (raced !== undefined && raced.request_sha256 === requestDigest && raced.policy_sha256 === policyDigest) {
      const current = await evaluateGuardrailAction(action, approval, new Date(), policy);
      if (sameDecisionState(raced, current)) {
        return { status: "idempotent", path: destination, decision: raced };
      }
      throw new DalError(
        "GUARDRAIL_DECISION_STALE",
        `Action ID ${action.action_id} raced with changed dynamic prerequisites; use a new action ID`,
      );
    }
    throw new DalError("GUARDRAIL_ID_CONFLICT", `Action ID ${action.action_id} raced with different content`);
  }
  return { status: "stored", path: destination, decision };
}

function sameDecisionState(left: GuardrailDecision, right: GuardrailDecision): boolean {
  return (
    left.effect === right.effect &&
    left.approval_ref === right.approval_ref &&
    left.approval_sha256 === right.approval_sha256 &&
    canonicalJson(left.matched_rules) === canonicalJson(right.matched_rules)
  );
}

export async function validateGuardrailDecision(value: unknown): Promise<GuardrailDecision> {
  await assertSchema(SCHEMA_IDS.guardrailDecision, value, "Guardrail decision");
  const decision = value as GuardrailDecision;
  const issues: string[] = [];
  if (decision.decision_id !== `gdec-${decision.request.action_id.slice(4)}`) {
    issues.push("/decision_id does not derive from /request/action_id");
  }
  if (decision.request_sha256 !== sha256(canonicalJson(decision.request))) {
    issues.push("/request_sha256 does not match /request");
  }
  if (overallEffect(decision.matched_rules) !== decision.effect) {
    issues.push("/effect does not match the strongest matched rule");
  }
  if ((decision.approval_ref === null) !== (decision.approval_sha256 === null)) {
    issues.push("/approval_ref and /approval_sha256 must either both be null or both be present");
  }
  if (issues.length > 0) {
    throw new DalError("GUARDRAIL_DECISION_INVALID", "Guardrail decision integrity check failed", issues);
  }
  await validateGuardrailAction(decision.request);
  assertNoSecrets(scanSecrets(decision));
  assertNoPii(scanPii(decision));
  return decision;
}

async function checkQuarantine(action: GuardrailAction, policy: Policy): Promise<RuleResult[]> {
  if (action.target.sha256 === null) {
    return [];
  }

  const store = resolve(process.cwd(), policy.default_evaluation_store);
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    return [
      {
        id: "quarantine-store-unavailable",
        effect: "denied",
        summary: "The local quarantine evidence store could not be read; policy fails closed",
      },
    ];
  }

  for (const name of names) {
    const recordPath = resolve(store, name);
    if (quarantineValidationContext.getStore()?.has(recordPath)) {
      continue;
    }
    try {
      const { value } = await readJsonFile<unknown>(recordPath);
      await assertSchema(SCHEMA_IDS.evaluationScorecard, value, "Evaluation scorecard");
      if ((value as EvaluationScorecard).target.sha256 !== action.target.sha256) {
        continue;
      }
      const activeRecords = new Set(quarantineValidationContext.getStore() ?? []);
      activeRecords.add(recordPath);
      const scorecard = await quarantineValidationContext.run(activeRecords, () =>
        validateEvaluationScorecard(value, {
          verifyCurrentContext: false,
          replayCases: true,
        }),
      );
      if (
        scorecard.target.sha256 === action.target.sha256 &&
        scorecard.result === "hard_stop" &&
        scorecard.hard_stop.disposition !== "continue"
      ) {
        const rollback = scorecard.hard_stop.disposition === "rollback";
        return [
          {
            id: rollback ? "artifact-rollback-required" : "artifact-quarantined",
            effect: "denied",
            summary: `Artifact digest is marked ${scorecard.hard_stop.disposition} by ${scorecard.scorecard_id}`,
          },
        ];
      }
    } catch {
      return [
        {
          id: "quarantine-store-invalid",
          effect: "denied",
          summary: "The local quarantine evidence store contains an invalid record; policy fails closed",
        },
      ];
    }
  }
  return [];
}

function checkBudget(action: GuardrailAction, policy: Policy, rules: RuleResult[]): void {
  const exceeded =
    action.budget.max_calls > policy.max_action_calls ||
    action.budget.max_duration_ms > policy.max_action_duration_ms ||
    action.budget.max_bytes_read > policy.max_action_bytes_read ||
    action.budget.max_bytes_written > policy.max_action_bytes_written ||
    action.budget.max_network_requests > policy.max_network_requests;
  rules.push({
    id: exceeded ? "budget-exceeded" : "budget-within-policy",
    effect: exceeded ? "denied" : "allowed",
    summary: exceeded ? "Requested budget exceeds a v0 policy maximum" : "Requested budget is within policy",
  });
}

function checkToolAndBoundary(action: GuardrailAction, policy: Policy, rules: RuleResult[]): void {
  if (!policy.allowed_tool_operations.includes(action.tool.operation)) {
    rules.push({ id: "tool-operation-denied", effect: "denied", summary: "Tool operation is not allowlisted" });
  } else {
    rules.push({ id: "tool-operation-allowed", effect: "allowed", summary: "Tool operation is allowlisted" });
  }

  if (action.sandbox.network !== "denied" || action.budget.max_network_requests !== 0) {
    rules.push({ id: "network-denied", effect: "denied", summary: "v0 requires a network-denied declaration" });
  }

  if (action.target.uri.startsWith("repo://") && repositoryUriPath(action.target.uri) === undefined) {
    rules.push({ id: "target-uri-denied", effect: "denied", summary: "Target is not a canonical repository URI" });
  }
  if (action.capability === "read_local" && repositoryUriPath(action.target.uri) === undefined) {
    rules.push({ id: "read-root-denied", effect: "denied", summary: "Local reads must use a repository-scoped URI" });
  }
  if (action.capability === "write_local_evidence") {
    if (!withinAllowedWriteRoot(action.target.uri, policy)) {
      rules.push({ id: "write-root-denied", effect: "denied", summary: "Local write target is outside policy-owned roots" });
    }
    if (action.sandbox.mode !== "isolated_write") {
      rules.push({ id: "write-sandbox-required", effect: "denied", summary: "Local writes require isolated_write mode" });
    }
  }
  if (action.capability === "run_local_verifier" && action.sandbox.mode === "none") {
    rules.push({ id: "sandbox-required", effect: "denied", summary: "Local verifier requests require a sandbox declaration" });
  }
  if (action.sandbox.writable_roots.some((root) => !withinAllowedWriteRoot(root, policy))) {
    rules.push({ id: "sandbox-write-root-denied", effect: "denied", summary: "Sandbox writable root is outside policy" });
  }
}

async function approvalMatches(
  action: GuardrailAction,
  sensitiveAction: SensitiveAction,
  approval: ApprovalDecision | undefined,
  now: Date,
): Promise<boolean> {
  if (approval === undefined || action.approval_ref === null || approval.decision_id !== action.approval_ref) {
    return false;
  }
  const scope = action.target.artifact_id ?? action.target.uri;
  try {
    await verifyApproval(approval, {
      action: sensitiveAction,
      scope,
      ...(sensitiveAction === "apply_optimization_candidate" && action.target.sha256 !== null
        ? { candidateSha256: action.target.sha256 }
        : {}),
      at: now,
    });
    return true;
  } catch (error) {
    if (error instanceof DalError) {
      return false;
    }
    throw error;
  }
}

function overallEffect(rules: readonly Pick<RuleResult, "effect">[]): GuardrailEffect {
  if (rules.some((rule) => rule.effect === "denied")) return "denied";
  if (rules.some((rule) => rule.effect === "requires_human_approval")) return "requires_human_approval";
  return "allowed";
}

function withinAllowedWriteRoot(uri: string, policy: Policy): boolean {
  return policy.allowed_write_roots.some((root) => repositoryUriWithin(uri, root));
}

async function enforceRateLimit(store: string, policy: Policy): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(store)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new DalError("GUARDRAIL_AUDIT_READ_FAILED", `Could not inspect guardrail audit store: ${store}`);
  }
  const cutoff = Date.now() - policy.policy_window_seconds * 1000;
  let recent = 0;
  for (const name of names) {
    const { value } = await readJsonFile<unknown>(resolve(store, name));
    const decision = await validateGuardrailDecision(value);
    if (Date.parse(decision.evaluated_at) >= cutoff) recent += 1;
  }
  if (recent >= policy.max_policy_checks_per_window) {
    throw new DalError("POLICY_RATE_LIMIT", "Guardrail policy-check rate limit reached");
  }
}

async function readExistingDecision(filePath: string): Promise<GuardrailDecision | undefined> {
  try {
    await access(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new DalError("GUARDRAIL_AUDIT_READ_FAILED", `Could not inspect guardrail decision: ${filePath}`);
  }
  const { value } = await readJsonFile<unknown>(filePath);
  return validateGuardrailDecision(value);
}
