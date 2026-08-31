import { DalError } from "./errors.js";
import { escapeJsonPointer, readJsonFile, resolveJsonPointer } from "./json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets, type SecretMatch } from "./privacy.js";
import { assertSchema, loadPolicy, SCHEMA_IDS } from "./schema.js";
import type { FeedbackLog, Policy } from "./types.js";

export interface ValidatedFeedbackDocument {
  feedback: FeedbackLog;
  raw: Buffer;
  policy: Policy;
  secretMatches: SecretMatch[];
}

export async function validateFeedbackDocument(filePath: string): Promise<ValidatedFeedbackDocument> {
  const policy = await loadPolicy();
  const document = await readJsonFile<unknown>(filePath);
  if (document.raw.byteLength > policy.max_feedback_bytes) {
    throw new DalError(
      "FEEDBACK_TOO_LARGE",
      `Feedback exceeds ${policy.max_feedback_bytes} bytes: ${filePath}`,
    );
  }
  const feedback = await validateFeedback(document.value, policy, document.raw.toString("utf8"));
  return { feedback, raw: document.raw, policy, secretMatches: [] };
}

export async function validateFeedback(
  value: unknown,
  suppliedPolicy?: Policy,
  rawText?: string,
): Promise<FeedbackLog> {
  const policy = suppliedPolicy ?? (await loadPolicy());
  await assertSchema(SCHEMA_IDS.feedback, value, "Feedback log");
  const feedback = value as FeedbackLog;
  const issues = semanticIssues(feedback, policy);
  if (issues.length > 0) {
    throw new DalError("FEEDBACK_SEMANTIC_INVALID", "Feedback log violates semantic rules", issues);
  }
  assertNoSecrets(scanSecrets(feedback, rawText));
  assertNoPii(scanPii(feedback, rawText));
  return feedback;
}

function semanticIssues(feedback: FeedbackLog, policy: Policy): string[] {
  const issues: string[] = [];

  if (feedback.supersedes === feedback.feedback_id) {
    issues.push("/supersedes cannot equal /feedback_id");
  }

  addDuplicateIssues(issues, "/acceptance_criteria", feedback.acceptance_criteria.map((criterion) => criterion.id));
  addDuplicateIssues(issues, "/evidence", feedback.evidence.map((evidence) => evidence.id));
  addDuplicateIssues(
    issues,
    "/failures_and_inefficiencies",
    feedback.failures_and_inefficiencies.map((failure) => failure.id),
  );
  addDuplicateIssues(issues, "/uncertainty", feedback.uncertainty.map((uncertainty) => uncertainty.id));

  if (feedback.outcome.status === "completed") {
    if (feedback.outcome.exception !== null) {
      issues.push("/outcome/exception must be null when status is completed");
    }
    for (const criterion of feedback.acceptance_criteria) {
      if (criterion.result !== "passed" && criterion.result !== "not_applicable") {
        issues.push(`/acceptance_criteria/${criterion.id} must be passed or not_applicable for completed work`);
      }
    }
  } else {
    if (feedback.outcome.exception === null || feedback.outcome.exception.kind !== feedback.outcome.status) {
      issues.push(`/outcome/exception must match ${feedback.outcome.status}`);
    }
  }

  let previousSequence = 0;
  const sequences = new Set<number>();
  feedback.calls.forEach((call, index) => {
    if (sequences.has(call.sequence)) {
      issues.push(`/calls/${index}/sequence must be unique`);
    }
    if (call.sequence <= previousSequence) {
      issues.push(`/calls/${index}/sequence must be strictly increasing`);
    }
    sequences.add(call.sequence);
    previousSequence = call.sequence;
  });

  const evidenceIds = new Set(feedback.evidence.map((evidence) => evidence.id));
  const references: Array<{ path: string; ids: string[] }> = [];
  feedback.acceptance_criteria.forEach((criterion, index) =>
    references.push({ path: `/acceptance_criteria/${index}/evidence`, ids: criterion.evidence }),
  );
  feedback.calls.forEach((call, index) => references.push({ path: `/calls/${index}/evidence`, ids: call.evidence }));
  feedback.failures_and_inefficiencies.forEach((failure, index) =>
    references.push({ path: `/failures_and_inefficiencies/${index}/evidence`, ids: failure.evidence }),
  );
  feedback.uncertainty.forEach((uncertainty, index) =>
    references.push({ path: `/uncertainty/${index}/evidence`, ids: uncertainty.evidence }),
  );
  for (const reference of references) {
    for (const id of reference.ids) {
      if (!evidenceIds.has(id)) {
        issues.push(`${reference.path} references missing evidence ${id}`);
      }
    }
  }

  const allowedSchemes = new Set(policy.allowed_evidence_schemes);
  feedback.evidence.forEach((evidence, index) => {
    const scheme = evidence.uri.slice(0, evidence.uri.indexOf("://")).toLowerCase();
    if (!allowedSchemes.has(scheme)) {
      issues.push(`/evidence/${index}/uri uses disallowed scheme ${scheme}`);
    }
  });

  const reviewedStatuses = new Set(["approved", "changes_requested", "rejected"]);
  if (reviewedStatuses.has(feedback.human_review.status)) {
    if (feedback.human_review.reviewer === null || feedback.human_review.reviewed_at === null) {
      issues.push("/human_review requires reviewer and reviewed_at for a completed review decision");
    }
  }

  addDuplicateIssues(issues, "/privacy/redactions", feedback.privacy.redactions.map((redaction) => redaction.path));
  const declaredRedactions = new Set<string>();
  feedback.privacy.redactions.forEach((redaction, index) => {
    if (redaction.path.startsWith("/privacy/redactions")) {
      issues.push(`/privacy/redactions/${index}/path cannot point into redaction metadata`);
      return;
    }
    const current = resolveJsonPointer(feedback, redaction.path);
    if (current !== redaction.marker) {
      issues.push(`/privacy/redactions/${index} does not resolve to its declared marker`);
    }
    declaredRedactions.add(`${redaction.path}\u0000${redaction.marker}`);
  });

  for (const marker of collectRedactionMarkers(feedback)) {
    if (!declaredRedactions.has(`${marker.path}\u0000${marker.value}`)) {
      issues.push(`${marker.path} contains an undeclared redaction marker`);
    }
  }

  return issues;
}

function addDuplicateIssues(issues: string[], path: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(`${path} contains duplicate ID ${value}`);
    }
    seen.add(value);
  }
}

function collectRedactionMarkers(value: unknown): Array<{ path: string; value: string }> {
  const markers: Array<{ path: string; value: string }> = [];
  const pattern = /^\[REDACTED:[A-Za-z0-9._-]+\]$/;

  const walk = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      if (pattern.test(current) && !path.startsWith("/privacy/redactions/")) {
        markers.push({ path, value: current });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}/${index}`));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        walk(child, `${path}/${escapeJsonPointer(key)}`);
      }
    }
  };

  walk(value, "");
  return markers;
}
