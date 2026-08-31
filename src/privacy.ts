import { escapeJsonPointer } from "./json.js";
import { DalError } from "./errors.js";

export interface SecretMatch {
  rule: string;
  path: string;
}

export interface PiiMatch {
  rule: string;
  path: string;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

const REDACTION_MARKER = /^\[REDACTED:[A-Za-z0-9._-]+\]$/;

const SECRET_RULES: readonly SecretRule[] = [
  { id: "private-key-header", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    id: "credentialed-connection-uri",
    pattern: /\b(?:mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s:/]+:[^\s/@]+@/i,
  },
  {
    id: "credential-assignment",
    pattern: /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{12,}/i,
  },
];

const SENSITIVE_FIELD = /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)$/i;

export function scanSecrets(value: unknown, rawText?: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  const record = (rule: string, path: string): void => {
    const key = `${rule}\u0000${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ rule, path });
    }
  };

  const inspect = (text: string, path: string, fieldName?: string): void => {
    if (REDACTION_MARKER.test(text)) {
      return;
    }
    if (fieldName !== undefined && SENSITIVE_FIELD.test(fieldName) && text.trim().length >= 8) {
      record("sensitive-field-value", path);
    }
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(text)) {
        record(rule.id, path);
      }
    }
  };

  const walk = (current: unknown, path: string, fieldName?: string): void => {
    if (typeof current === "string") {
      inspect(current, path, fieldName);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}/${index}`));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        walk(child, `${path}/${escapeJsonPointer(key)}`, key);
      }
    }
  };

  walk(value, "");
  if (rawText !== undefined) {
    inspect(rawText, "/$raw");
  }
  return matches.sort((left, right) => left.rule.localeCompare(right.rule) || left.path.localeCompare(right.path));
}

export function assertNoSecrets(matches: readonly SecretMatch[]): void {
  if (matches.length === 0) {
    return;
  }
  const rules = [...new Set(matches.map((match) => match.rule))].sort();
  throw new DalError(
    "SECRET_DETECTED",
    `Likely secret detected by ${rules.join(", ")}; no data was persisted`,
    matches.map((match) => `${match.path || "/"}: ${match.rule}`),
  );
}

const PII_RULES: readonly SecretRule[] = [
  { id: "email-address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i },
  { id: "us-social-security-number", pattern: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/ },
  { id: "formatted-phone-number", pattern: /\b(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/ },
];

const PERSONAL_FIELD = /^(?:email|email_address|phone|phone_number|ssn|social_security_number|credit_card)$/i;
const DIGEST_FIELD = /(?:sha256|digest|hash)$/i;
const SHA256_VALUE = /^[a-f0-9]{64}$/i;

export function scanPii(value: unknown, rawText?: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  const seen = new Set<string>();

  const record = (rule: string, path: string): void => {
    const key = `${rule}\u0000${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ rule, path });
    }
  };

  const inspect = (text: string, path: string, fieldName?: string): void => {
    if (REDACTION_MARKER.test(text)) {
      return;
    }
    if (fieldName !== undefined && PERSONAL_FIELD.test(fieldName) && text.trim().length > 0) {
      record("personal-field-value", path);
    }
    for (const rule of PII_RULES) {
      if (rule.pattern.test(text)) {
        record(rule.id, path);
      }
    }
    const digestValue =
      fieldName !== undefined && DIGEST_FIELD.test(fieldName) && SHA256_VALUE.test(text);
    if (path !== "/$raw" && !digestValue && containsPaymentCard(text)) {
      record("payment-card-number", path);
    }
  };

  const walk = (current: unknown, path: string, fieldName?: string): void => {
    if (typeof current === "string") {
      inspect(current, path, fieldName);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}/${index}`));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        walk(child, `${path}/${escapeJsonPointer(key)}`, key);
      }
    }
  };

  walk(value, "");
  if (rawText !== undefined) {
    inspect(rawText, "/$raw");
  }
  return matches.sort((left, right) => left.rule.localeCompare(right.rule) || left.path.localeCompare(right.path));
}

export function assertNoPii(matches: readonly PiiMatch[]): void {
  if (matches.length === 0) {
    return;
  }
  const rules = [...new Set(matches.map((match) => match.rule))].sort();
  throw new DalError(
    "PII_DETECTED",
    `Likely PII detected by ${rules.join(", ")}; redact it before persistence`,
    matches.map((match) => `${match.path || "/"}: ${match.rule}`),
  );
}

function containsPaymentCard(text: string): boolean {
  for (const match of text.matchAll(/(?<![A-Za-z0-9])(?:\d[ -]?){13,19}(?![A-Za-z0-9])/g)) {
    const digits = match[0].replaceAll(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return true;
    }
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
