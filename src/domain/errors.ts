export class SessionPlaneDomainError extends Error {
  readonly errorCode: string;
  readonly details: unknown;

  constructor(errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SessionPlaneDomainError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

export function assertDomain(
  condition: unknown,
  errorCode: string,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) {
    throw new SessionPlaneDomainError(errorCode, message, details);
  }
}

