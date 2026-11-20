import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../lib/http-error.js";

/**
 * Reusable request validation.
 *
 * Parsed values are stored separately in `req.validated` instead of overwriting
 * `req.body` / `req.query` / `req.params`. Express 5 exposes `req.query` as a
 * getter-only property, and keeping the raw request untouched makes it obvious
 * that only the validated output may be trusted by handlers.
 *
 * Validation is deliberately unaware of tenant scoping: a parsed body can carry
 * a `tenantId`, but it is just data and never becomes the request's tenant
 * context (see `lib/request-context.ts`).
 */

export type ValidationSource = "body" | "params" | "query";

export interface ValidatedValues {
  readonly body?: unknown;
  readonly params?: unknown;
  readonly query?: unknown;
}

declare global {
  namespace Express {
    interface Request {
      /** Populated by `validate()`; absent on unvalidated routes. */
      validated: ValidatedValues;
    }
  }
}

export interface ValidationSchemas {
  readonly body?: z.ZodType;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
}

export interface ValidationIssue {
  readonly source: ValidationSource;
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

const SOURCES: readonly ValidationSource[] = ["body", "params", "query"];

/**
 * Validates the requested parts of the request and rejects with a 422
 * `VALIDATION_ERROR` carrying one entry per failing field.
 *
 * @example
 * router.post(
 *   "/",
 *   validate({ body: createPatientSchema }),
 *   (req, res) => sendCreated(res, getValidated<typeof createPatientSchema>(req, "body")),
 * );
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const parsed: Partial<Record<ValidationSource, unknown>> = {};
    const issues: ValidationIssue[] = [];

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            source,
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          });
        }
        continue;
      }

      parsed[source] = result.data;
    }

    if (issues.length > 0) {
      next(AppError.validation("Request validation failed", issues));
      return;
    }

    req.validated = { ...req.validated, ...parsed };
    next();
  };
}

/**
 * Typed accessor for a value produced by `validate()`. Throws if the route was
 * not validated for that source, which catches middleware wiring mistakes.
 */
export function getValidated<S extends z.ZodType>(
  req: Request,
  source: ValidationSource,
): z.output<S> {
  const values: ValidatedValues | undefined = req.validated;
  const value = values?.[source];

  if (value === undefined) {
    throw new Error(`Request ${source} was not validated by the validate() middleware`);
  }

  return value as z.output<S>;
}
