/**
 * Operational error that is safe to expose to API clients.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly isOperational = true;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(message = "Bad request", details?: unknown): AppError {
    return new AppError(400, "BAD_REQUEST", message, details);
  }

  static unauthorized(message = "Unauthorized"): AppError {
    return new AppError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "Forbidden"): AppError {
    return new AppError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  }

  static conflict(message = "Conflict", details?: unknown): AppError {
    return new AppError(409, "CONFLICT", message, details);
  }

  static unprocessable(message = "Unprocessable entity", details?: unknown): AppError {
    return new AppError(422, "UNPROCESSABLE_ENTITY", message, details);
  }

  static validation(message = "Request validation failed", details?: unknown): AppError {
    return new AppError(422, "VALIDATION_ERROR", message, details);
  }

  static tooManyRequests(message = "Too many requests", details?: unknown): AppError {
    return new AppError(429, "RATE_LIMITED", message, details);
  }

  static payloadTooLarge(message = "Request payload too large"): AppError {
    return new AppError(413, "PAYLOAD_TOO_LARGE", message);
  }

  static internal(message = "Internal server error"): AppError {
    return new AppError(500, "INTERNAL_ERROR", message);
  }

  static serviceUnavailable(message = "Service unavailable"): AppError {
    return new AppError(503, "SERVICE_UNAVAILABLE", message);
  }
}
