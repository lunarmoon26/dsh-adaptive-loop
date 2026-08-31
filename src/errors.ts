export class DalError extends Error {
  readonly code: string;
  readonly issues: readonly string[];

  constructor(code: string, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "DalError";
    this.code = code;
    this.issues = issues;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
