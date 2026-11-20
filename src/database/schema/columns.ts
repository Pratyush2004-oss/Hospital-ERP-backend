import { timestamp } from "drizzle-orm/pg-core";

/** TIMESTAMPTZ creation column shared by every table. */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** TIMESTAMPTZ update column; refreshed by Drizzle on every update. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Bit-flag soft delete marker; `null` means the row is live. */
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
