import { sql } from "drizzle-orm";
import {
  withPlatformTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import { auditLogs } from "../../database/schema/index.js";
import { logger } from "../../lib/logger.js";
import {
  getRequestActor,
  getRequestMetadata,
} from "../../lib/request-context.js";
import type {
  AuditActorScope,
  AuditEventInput,
} from "./audit.types.js";

/**
 * Central audit writer (Phase 21.1).
 *
 * Audit rows are written on the caller's transaction, so a business rollback
 * also removes its audit record: the table never claims a successful operation
 * that never committed. `recordAuditSafely` adds a savepoint so an audit write
 * failure cannot abort an otherwise valid business transaction.
 *
 * Every free-form value passes through `redactAuditValue` first. That removes
 * credentials, tokens, card data, contact details and clinical free text, and
 * bounds depth/size so one huge request body cannot bloat the audit table.
 */

const MAX_DESCRIPTION = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_LENGTH = 1_000;

const REDACTED = "[REDACTED]";

/**
 * Field names that never belong in an audit snapshot. The list is intentionally
 * broad: a false positive costs a small amount of debugging detail, while a
 * false negative can leak a credential or patient information.
 */
const SENSITIVE_KEY_PATTERN =
  /pass(word|phrase)?|token|secret|api[-_]?key|authorization|cookie|credential|credit[-_]?card|card[-_]?(number|no)|cvv|cvc|ssn|social[-_]?security|\bpin\b|\botp\b|medical|diagnos|prescription|treatment|clinical|symptom|\bnotes?\b|\breason\b|phone|mobile|email|address|date[-_]?of[-_]?birth|\bdob\b/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]`
    : value;
}

/**
 * Deep-redacts an arbitrary value for storage. Dates become ISO strings, bigint
 * values become strings, and functions/symbols are dropped.
 */
export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactAuditValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );

    for (const [key, item] of entries) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED;
        continue;
      }

      const redacted = redactAuditValue(item, depth + 1);
      if (redacted !== undefined) output[key] = redacted;
    }

    return output;
  }

  return undefined;
}

function redactMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const redacted = redactAuditValue(metadata ?? {});

  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

function defaultActorScope(): AuditActorScope {
  const actor = getRequestActor();
  if (!actor) return "SYSTEM";
  if (actor.kind === "tenant") return "TENANT";
  if (actor.kind === "platform") return "PLATFORM";
  return "USER";
}

function requestAuditContext() {
  const metadata = getRequestMetadata();
  return {
    requestId: metadata.requestId?.slice(0, 100) ?? null,
    ipAddress: metadata.ipAddress?.slice(0, 64) ?? null,
    userAgent: metadata.userAgent?.slice(0, 512) ?? null,
  };
}

/**
 * Writes one audit row on the caller's transaction.
 *
 * `onConflictDoNothing()` is used without a target so the optional dedupe index
 * (and any future unique index) cannot turn a duplicate event into an error.
 */
export async function recordAudit(
  tx: DatabaseTransaction,
  input: AuditEventInput,
): Promise<string | null> {
  const request = requestAuditContext();
  const actor = getRequestActor();

  const [row] = await tx
    .insert(auditLogs)
    .values({
      tenantId: input.tenantId ?? null,
      branchId: input.branchId ?? null,
      actorUserId: input.actorUserId ?? actor?.userId ?? null,
      actorScope: input.actorScope ?? defaultActorScope(),
      action: input.action.slice(0, 120),
      module: input.module.slice(0, 60),
      resourceType: input.resourceType?.slice(0, 100) ?? null,
      resourceId: input.resourceId?.slice(0, 200) ?? null,
      description: input.description?.slice(0, MAX_DESCRIPTION) ?? null,
      previousState:
        input.previousState === undefined
          ? null
          : redactAuditValue(input.previousState),
      newState:
        input.newState === undefined ? null : redactAuditValue(input.newState),
      metadata: redactMetadata(input.metadata),
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      dedupeKey: input.dedupeKey?.slice(0, 250) ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: auditLogs.id });

  return row?.id ?? null;
}

/**
 * Savepoint-protected audit write for business transactions.
 *
 * The row still commits or rolls back with the business transaction, but an
 * audit table problem (or an oversized/invalid value) cannot fail the business
 * operation. The savepoint is reused sequentially inside one transaction.
 */
export async function recordAuditSafely(
  tx: DatabaseTransaction,
  input: AuditEventInput,
): Promise<string | null> {
  try {
    await tx.execute(sql`savepoint audit_log_write`);
  } catch (error) {
    logger.warn({ err: error, action: input.action }, "Audit savepoint failed");
    return null;
  }

  try {
    const id = await recordAudit(tx, input);
    await tx.execute(sql`release savepoint audit_log_write`);
    return id;
  } catch (error) {
    try {
      await tx.execute(sql`rollback to savepoint audit_log_write`);
      await tx.execute(sql`release savepoint audit_log_write`);
    } catch {
      // Preserve the original business transaction.
    }

    logger.warn(
      { err: error, action: input.action, module: input.module },
      "Audit write failed; business transaction preserved",
    );
    return null;
  }
}

/**
 * Standalone audit write for events that are not part of a business
 * transaction (login, logout, authorization denial). Uses the platform context
 * so a row with no tenant (pre-tenant login) can still be inserted under RLS.
 * Never throws.
 */
export async function recordAuditStandalone(input: AuditEventInput): Promise<string | null> {
  try {
    return await withPlatformTransaction((tx) => recordAudit(tx, input));
  } catch (error) {
    logger.warn(
      { err: error, action: input.action, module: input.module },
      "Standalone audit write failed",
    );
    return null;
  }
}

/** Convenience helpers implementing the standard create/update/delete shape. */
export function recordCreateAudit(
  tx: DatabaseTransaction,
  input: Omit<AuditEventInput, "previousState">,
): Promise<string | null> {
  return recordAuditSafely(tx, input);
}

export function recordUpdateAudit(
  tx: DatabaseTransaction,
  input: Omit<AuditEventInput, "newState"> & { readonly newState?: unknown },
): Promise<string | null> {
  return recordAuditSafely(tx, input);
}

export function recordDeleteAudit(
  tx: DatabaseTransaction,
  input: Omit<AuditEventInput, "newState">,
): Promise<string | null> {
  return recordAuditSafely(tx, input);
}

/** Metadata-only field-name list; never field values. */
export function changedFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...keys].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
