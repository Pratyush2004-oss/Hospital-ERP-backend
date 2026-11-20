import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { errorBody } from "../lib/api-response.js";
import { AppError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";

/** Shape of the errors thrown by `express.json()` / `express.urlencoded()`. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
  body?: unknown;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(errorBody(res, "NOT_FOUND", `Route ${req.method} ${req.originalUrl} not found`));
};

interface NormalizedError {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return error instanceof Error && (typeof (error as BodyParserError).type === "string" || "body" in error);
}

/**
 * Maps anything thrown in the stack to a safe, client-facing error.
 * Unexpected errors never leak their message or stack to the client.
 */
function normalizeError(error: unknown): NormalizedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") {
      return {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Request payload is too large",
      };
    }

    if (error.type === "encoding.unsupported") {
      return {
        statusCode: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Unsupported request encoding",
      };
    }

    if (error instanceof SyntaxError) {
      return {
        statusCode: 400,
        code: "MALFORMED_JSON",
        message: "Request body is not valid JSON",
      };
    }
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error",
  };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // The response is already in flight; let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const log = req.log ?? logger;
  const normalized = normalizeError(err);

  if (normalized.statusCode >= 500) {
    log.error({ err }, "Unhandled request error");
  } else {
    log.warn({ err, statusCode: normalized.statusCode }, "Request rejected");
  }

  res
    .status(normalized.statusCode)
    .json(
      errorBody(res, normalized.code, normalized.message, normalized.details),
    );
};
