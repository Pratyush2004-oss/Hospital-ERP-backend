import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../database/context.js";
import { patientContacts, users } from "../../database/schema/index.js";
import type { NotificationChannel } from "./notification.types.js";

/**
 * Recipient resolution and safe formatting for central notifications.
 *
 * Contact addresses are read from the tenant-scoped patient contact table or
 * the account record, never from an event payload. Only a normalized address is
 * copied onto the outbox row; logs and API responses never include it.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[1-9]\d{7,14}$/;

export interface NotificationRecipientSource {
  readonly userId?: string;
  readonly patientId?: string;
}

export function normalizeNotificationRecipient(
  channel: NotificationChannel,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;

  if (channel === "EMAIL") {
    const normalized = value.trim().toLowerCase();
    return EMAIL_PATTERN.test(normalized) ? normalized : null;
  }

  const normalized = value.replace(/[A-Za-z()\s.-]/g, "");
  return PHONE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Resolves the best address for a channel.
 *
 * Patients prefer their primary contact row. Staff accounts fall back to the
 * global account email/phone. `IN_APP` has no external address and returns
 * null, but remains deliverable to the owning user.
 */
export async function resolveNotificationRecipient(
  tx: DatabaseTransaction,
  tenantId: string,
  source: NotificationRecipientSource,
  channel: NotificationChannel,
): Promise<string | null> {
  if (channel === "IN_APP") return null;

  if (source.patientId !== undefined) {
    const rows = await tx
      .select({
        phone: patientContacts.phone,
        email: patientContacts.email,
      })
      .from(patientContacts)
      .where(
        and(
          eq(patientContacts.tenantId, tenantId),
          eq(patientContacts.patientId, source.patientId),
          channel === "EMAIL"
            ? sql`${patientContacts.email} is not null`
            : sql`${patientContacts.phone} is not null`,
        ),
      )
      .orderBy(desc(patientContacts.isPrimary), asc(patientContacts.createdAt));

    for (const row of rows) {
      const address = normalizeNotificationRecipient(
        channel,
        channel === "EMAIL" ? row.email : row.phone,
      );
      if (address !== null) return address;
    }
  }

  if (source.userId !== undefined) {
    const [user] = await tx
      .select({ email: users.email, phone: users.phone, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, source.userId))
      .limit(1);

    if (user?.isActive) {
      return normalizeNotificationRecipient(
        channel,
        channel === "EMAIL" ? user.email : user.phone,
      );
    }
  }

  return null;
}

/** Formats an instant in a branch timezone, e.g. "07 Dec 2026, 09:00 IST". */
export function formatNotificationInstant(
  instant: Date,
  timeZone: string,
  locale: "EN" | "HI" = "EN",
): string {
  try {
    return new Intl.DateTimeFormat(locale === "HI" ? "hi-IN" : "en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(instant);
  } catch {
    // An invalid tenant timezone must not block a business transaction.
    return instant.toISOString();
  }
}
