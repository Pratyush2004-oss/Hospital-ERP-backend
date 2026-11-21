import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ quiet: true });

/** Ensures the prefix starts with "/" and has no trailing slash ("/api/v1"). */
function normalizeApiPrefix(prefix: string): string {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
}

function resolveRedisUrl(source: NodeJS.ProcessEnv): string | undefined {
  const directUrl = source.REDIS_URL?.trim();
  if (directUrl) return directUrl;

  const restUrl = source.UPSTASH_REDIS_REST_URL?.trim() || source.KV_REST_API_URL?.trim();
  const token = source.UPSTASH_REDIS_REST_TOKEN?.trim() || source.KV_REST_API_TOKEN?.trim();
  if (!restUrl || !token) return undefined;

  try {
    const parsed = new URL(restUrl);
    const redisUrl = new URL("rediss://default@127.0.0.1:6379");
    redisUrl.hostname = parsed.hostname;
    redisUrl.port = "6379";
    redisUrl.password = token;
    return redisUrl.toString();
  } catch {
    return undefined;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PREFIX: z.string().trim().min(1).default("/api/v1").transform(normalizeApiPrefix),
  FRONTEND_URL: z.url().default("http://localhost:3000"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // HTTP hardening
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),

  // Authentication. The access-token secret signs short-lived JWTs; refresh
  // tokens are opaque random strings whose hashes live in PostgreSQL.
  AUTH_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, "must be at least 32 characters of high-entropy secret"),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  AUTH_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(900_000),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /** Optional bootstrap account that receives the platform super-admin role. */
  PLATFORM_SUPER_ADMIN_EMAIL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().toLowerCase().pipe(z.email()).optional(),
  ),

  // PostgreSQL. DATABASE_URL is the administrative/migration connection;
  // APP_DATABASE_URL, when set, is the restricted runtime role that RLS
  // applies to. Never serve requests with a superuser or BYPASSRLS role.
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "must be a postgres:// or postgresql:// connection string",
    ),
  APP_DATABASE_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
        "must be a postgres:// or postgresql:// connection string",
      )
      .optional(),
  ),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().int().min(0).default(30_000),
  DB_CONNECTION_TIMEOUT: z.coerce.number().int().min(0).default(5_000),
  DB_SSL: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() === "true" : value),
      z.boolean(),
    )
    .default(false),

  // Private document storage. Files are written outside the web root; the API
  // never serves this directory statically, so a storage key is only reachable
  // through an authorized, signed download.
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  /** Directory for the local adapter, relative to the process working directory. */
  STORAGE_LOCAL_ROOT: z.string().trim().min(1).default("storage/private"),
  /** Hard ceiling for one uploaded document (bytes). Defaults to 10 MiB. */
  STORAGE_MAX_FILE_SIZE_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  /** Lifetime of a signed download URL, in seconds. */
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /**
   * Secret for local signed URLs. Optional: when unset a storage-specific key is
   * derived from AUTH_ACCESS_TOKEN_SECRET, so development needs no extra value.
   * Set it explicitly in production to isolate storage URLs from auth tokens.
   */
  STORAGE_SIGNING_SECRET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32, "must be at least 32 characters").optional(),
  ),

  // Payment gateway. The core billing code depends only on the provider-neutral
  // `PaymentGateway` interface; this selects the adapter. `mock` is the
  // deterministic test/dev provider shipped with Phase 19.6.1, so no live
  // credentials are required to exercise initiation. A real provider adapter is
  // added by selecting its registry key and supplying its secret here; secrets
  // are never hardcoded and never returned to clients or logged.
  PAYMENT_GATEWAY_PROVIDER: z.enum(["mock"]).default("mock"),
  PAYMENT_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  PAYMENT_GATEWAY_CHECKOUT_BASE_URL: z
    .url()
    .default("https://sandbox.payments.invalid/checkout"),
  /** Optional provider API key. Unused by `mock`; required by real adapters. */
  PAYMENT_GATEWAY_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(16, "must be at least 16 characters").optional(),
  ),

  // Billing notifications (Phase 19.10). No live provider is assumed. `mock`
  // records deterministic provider ids without sending anything and is used by
  // tests; `none` marks deliveries SKIPPED (provider not configured).
  BILLING_NOTIFICATION_EMAIL_PROVIDER: z.enum(["none", "mock"]).default("none"),
  BILLING_NOTIFICATION_SMS_PROVIDER: z.enum(["none", "mock"]).default("none"),
  BILLING_NOTIFICATION_FROM_EMAIL: z.email().default("no-reply@hospitalos.invalid"),
  BILLING_NOTIFICATION_FROM_SMS: z.string().trim().min(1).max(40).default("HOSPITAL"),
  BILLING_NOTIFICATION_RETRY_BASE_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
  BILLING_NOTIFICATION_PROCESSING_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_600)
    .default(300),
  BILLING_NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  BILLING_REMINDER_SCHEDULER_ENABLED: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value.trim().toLowerCase() === "true"
          : value,
      z.boolean(),
    )
    .default(true),
  BILLING_REMINDER_SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .default(60_000),

  // Central notifications. `mock` is deterministic and never contacts an
  // external provider; `none` leaves delivery unavailable until an adapter is
  // configured.
  NOTIFICATION_EMAIL_PROVIDER: z.enum(["none", "mock"]).default("none"),
  NOTIFICATION_SMS_PROVIDER: z.enum(["none", "mock"]).default("none"),
  NOTIFICATION_WHATSAPP_PROVIDER: z.enum(["none", "mock"]).default("none"),
  NOTIFICATION_RETRY_BASE_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  NOTIFICATION_PROCESSING_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_600)
    .default(300),
  NOTIFICATION_WORKER_ENABLED: z
    .preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toLowerCase() === "true" : value,
      z.boolean(),
    )
    .default(true),
  NOTIFICATION_WORKER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(15_000),

  // Appointment reminders. Minutes are measured before the appointment start
  // instant; the branch timezone is used only for rendering the message.
  APPOINTMENT_REMINDER_MINUTES: z.string().trim().default("1440,60"),
  APPOINTMENT_REMINDER_SCHEDULER_ENABLED: z
    .preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toLowerCase() === "true" : value,
      z.boolean(),
    )
    .default(true),
  APPOINTMENT_REMINDER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .default(60_000),

  // Redis
  REDIS_URL: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "must be a redis:// or rediss:// connection string",
    ),
  REDIS_CONNECT_TIMEOUT: z.coerce.number().int().min(0).default(5_000),
  REDIS_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(3),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the raw process environment once, at startup, so the rest of the
 * application can rely on a typed and fully populated config object.
 *
 * Only variables required to start the app are validated here.
 */
function parseEnv(source: NodeJS.ProcessEnv): Env {
  const resolvedSource = { ...source };
  resolvedSource.REDIS_URL ??= resolveRedisUrl(source);
  const result = envSchema.safeParse(resolvedSource);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

/**
 * Administrative/owning connection used by migrations, seeds, and role
 * provisioning — never by the HTTP server.
 */
export function getAdminDatabaseUrl(): string {
  return env.DATABASE_URL;
}
