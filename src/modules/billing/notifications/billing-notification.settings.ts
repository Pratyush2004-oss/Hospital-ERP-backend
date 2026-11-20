import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseTransaction } from "../../../database/context.js";
import { tenantSettings } from "../../../database/schema/index.js";
import { logger } from "../../../lib/logger.js";
import {
  BILLING_NOTIFICATION_CHANNELS,
  DEFAULT_BILLING_NOTIFICATION_SETTINGS,
  type BillingNotificationSettings,
} from "./billing-notification.types.js";

/**
 * Tenant-level billing notification configuration.
 *
 * Stored in the existing `tenant_settings` table under one key, so the current
 * tenant settings API/authorization governs updates and no second settings
 * system is introduced. Invalid or absent configuration falls back to safe
 * defaults; reminder delivery never fails because settings are malformed.
 */
export const BILLING_NOTIFICATION_SETTINGS_KEY = "billing.notifications";

const settingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    channels: z.array(z.enum(BILLING_NOTIFICATION_CHANNELS)).max(2).default(["EMAIL"]),
    dueSoonDays: z
      .array(z.number().int().min(1).max(90))
      .max(10)
      .default([7, 3, 1]),
    overdueEveryDays: z.number().int().min(1).max(90).default(7),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retryBaseSeconds: z.number().int().min(30).max(86_400).optional(),
  })
  .strict();

export async function loadBillingNotificationSettings(
  tx: DatabaseTransaction,
  tenantId: string,
): Promise<BillingNotificationSettings> {
  const [row] = await tx
    .select({ value: tenantSettings.settingValue })
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, tenantId),
        eq(tenantSettings.settingKey, BILLING_NOTIFICATION_SETTINGS_KEY),
      ),
    )
    .limit(1);

  if (!row) return DEFAULT_BILLING_NOTIFICATION_SETTINGS;

  const parsed = settingsSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.warn(
      { tenantId, setting: BILLING_NOTIFICATION_SETTINGS_KEY },
      "Invalid billing notification settings; using defaults",
    );
    return DEFAULT_BILLING_NOTIFICATION_SETTINGS;
  }

  return {
    ...DEFAULT_BILLING_NOTIFICATION_SETTINGS,
    ...parsed.data,
    channels: [...parsed.data.channels],
    dueSoonDays: [...parsed.data.dueSoonDays].sort((a, b) => b - a),
  };
}
