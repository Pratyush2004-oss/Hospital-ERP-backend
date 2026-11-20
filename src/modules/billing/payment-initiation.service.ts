import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import {
  invoicePayments,
  invoiceRefunds,
  invoices,
  paymentAllocations,
  paymentGatewayOrders,
  payments,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { recordPaymentAudit } from "./billing.audit.js";
import {
  createPaymentGateway,
  getPaymentGateway,
  paymentGatewayConfigFromEnv,
} from "./gateway/payment-gateway.registry.js";
import {
  PaymentGatewayRequestError,
  PaymentGatewayTimeoutError,
  type GatewayCheckoutOrder,
  type PaymentGateway,
  type PaymentGatewayMetadataValue,
  type PaymentGatewayProviderName,
} from "./gateway/payment-gateway.types.js";
import { calculateInvoiceBalance, compareMoney } from "./invoice-calculation.js";
import { assertBranchInTenant } from "./invoice.service.js";
import type {
  GatewayPaymentMethod,
  InitiatePaymentDependencies,
  InitiatePaymentInput,
  PaymentInitiationDto,
} from "./payment-initiation.types.js";
import type { PaymentActorContext } from "./payment.types.js";

/**
 * Secure online payment initiation (Task 19.6.1).
 *
 * One call creates a provider checkout order and, in the same transaction, a
 * `PENDING` receipt plus its allocation and the `payment_gateway_orders` row.
 * No `invoice_payments` settlement is written, so an open checkout never moves
 * `amount_paid` or `balance_due`; only verified success (next task) may do that.
 *
 * Trust model:
 * - the tenant comes from the verified session, never from input;
 * - the invoice is read through the tenant-scoped transaction, so a foreign id
 *   is a 404 rather than a cross-tenant order;
 * - amount, currency, patient and branch are derived from the invoice ledger,
 *   not accepted from the client;
 * - the client cannot supply a payment status, provider order id or transaction
 *   reference, and none is trusted when one is echoed back to the provider.
 *
 * Failure behaviour:
 * - the provider is called inside the transaction with a bounded timeout;
 * - a rejection, timeout or malformed provider response throws before any row
 *   is inserted, so the transaction rolls back and no orphan pending payment,
 *   allocation or order survives;
 * - operational failures are logged with identifiers and an error kind only -
 *   never credentials, request bodies or provider payloads.
 *
 * Idempotency:
 * - a transaction-scoped advisory lock serializes the same tenant+key;
 * - the key and SHA-256 of the canonical request are stored on `payments`, so a
 *   retry replays the existing order, while reusing the key for a different
 *   invoice/method/provider is a 409.
 */

const GATEWAY_METHODS: ReadonlySet<string> = new Set<GatewayPaymentMethod>([
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "OTHER",
]);

const PAYABLE_STATUSES: ReadonlySet<string> = new Set([
  "ISSUED",
  "PARTIALLY_PAID",
  "OVERDUE",
]);

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROVIDER_ORDER_ID_LENGTH = 120;
const MAX_CHECKOUT_URL_LENGTH = 2_048;
const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_STRING_LENGTH = 500;
const MAX_METADATA_KEY_LENGTH = 64;

/** Keys that must never be persisted from a provider response. */
const FORBIDDEN_METADATA_KEY =
  /(secret|token|password|authorization|api[-_]?key|card|cvv|pan|credential)/i;

function assertActor(actor: PaymentActorContext): PaymentActorContext {
  if (!actor || typeof actor.userId !== "string" || actor.userId.length === 0) {
    throw AppError.internal("Payment initiation requires an authenticated actor");
  }

  return actor;
}

function normalizeIdempotencyKey(value: string): string {
  const key = typeof value === "string" ? value.trim() : "";

  if (key.length === 0) {
    throw AppError.validation("An Idempotency-Key header is required", {
      field: "idempotencyKey",
    });
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw AppError.validation(
      `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      { field: "idempotencyKey" },
    );
  }

  return key;
}

function assertGatewayMethod(method: string): GatewayPaymentMethod {
  if (!GATEWAY_METHODS.has(method)) {
    throw AppError.validation(
      "Only CARD, UPI, BANK_TRANSFER or OTHER can be initiated online",
      { field: "method" },
    );
  }

  return method as GatewayPaymentMethod;
}

/** Canonical request hash; the key itself is deliberately excluded. */
function requestHashOf(
  invoiceId: string,
  method: GatewayPaymentMethod,
  provider: PaymentGatewayProviderName,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ invoiceId, method, provider }))
    .digest("hex");
}

/**
 * Keeps only short JSON-safe primitives and drops anything that looks like a
 * credential. The provider contract is already non-secret, but defence in depth
 * means an adapter bug cannot leak a token into the database.
 */
function sanitizeGatewayMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, PaymentGatewayMetadataValue> {
  if (!metadata) return {};

  const safe: Record<string, PaymentGatewayMetadataValue> = {};
  let entries = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (entries >= MAX_METADATA_ENTRIES) break;
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) continue;
    if (FORBIDDEN_METADATA_KEY.test(key)) continue;

    if (typeof value === "string") {
      if (value.length > MAX_METADATA_STRING_LENGTH) continue;
      safe[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      safe[key] = value;
    } else {
      continue;
    }

    entries += 1;
  }

  return safe;
}

/** A provider response is untrusted input too: normalize or reject it. */
function validateGatewayOrder(
  order: GatewayCheckoutOrder,
  provider: PaymentGatewayProviderName,
): {
  readonly orderId: string;
  readonly transactionReference: string | null;
  readonly checkoutUrl: string;
  readonly expiresAt: Date | null;
  readonly metadata: Record<string, PaymentGatewayMetadataValue>;
} {
  const orderId = typeof order.orderId === "string" ? order.orderId.trim() : "";

  if (order.provider !== provider || orderId.length === 0) {
    throw new PaymentGatewayRequestError(provider, "Provider returned an invalid order");
  }

  if (orderId.length > MAX_PROVIDER_ORDER_ID_LENGTH) {
    throw new PaymentGatewayRequestError(provider, "Provider order id is too long");
  }

  const transactionReference =
    typeof order.transactionReference === "string" &&
    order.transactionReference.trim().length > 0
      ? order.transactionReference.trim().slice(0, MAX_PROVIDER_ORDER_ID_LENGTH)
      : null;

  let checkoutUrl: string;

  try {
    const parsed = new URL(order.checkoutUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    checkoutUrl = parsed.toString();
  } catch {
    throw new PaymentGatewayRequestError(provider, "Provider returned an invalid checkout URL");
  }

  if (checkoutUrl.length > MAX_CHECKOUT_URL_LENGTH) {
    throw new PaymentGatewayRequestError(provider, "Provider checkout URL is too long");
  }

  const expiresAt =
    order.expiresAt instanceof Date && !Number.isNaN(order.expiresAt.getTime())
      ? order.expiresAt
      : null;

  return {
    orderId,
    transactionReference,
    checkoutUrl,
    expiresAt,
    metadata: sanitizeGatewayMetadata(order.metadata),
  };
}

function gatewayFailure(error: unknown): AppError {
  if (error instanceof PaymentGatewayTimeoutError) {
    return new AppError(
      504,
      "PAYMENT_GATEWAY_TIMEOUT",
      "The payment provider did not respond in time. Please try again.",
    );
  }

  if (error instanceof PaymentGatewayRequestError) {
    return new AppError(
      502,
      "PAYMENT_GATEWAY_ERROR",
      "The payment provider could not create a checkout order. Please try again.",
    );
  }

  return new AppError(
    502,
    "PAYMENT_GATEWAY_ERROR",
    "The payment provider could not create a checkout order. Please try again.",
  );
}

async function replayIfPresent(
  tx: DatabaseTransaction,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
  actor: PaymentActorContext,
): Promise<PaymentInitiationDto | null> {
  const [existing] = await tx
    .select({ id: payments.id, requestHash: payments.requestHash })
    .from(payments)
    .where(
      and(eq(payments.tenantId, tenantId), eq(payments.idempotencyKey, idempotencyKey)),
    )
    .limit(1);

  if (!existing) return null;

  if (existing.requestHash !== requestHash) {
    throw AppError.conflict(
      "This idempotency key was already used to initiate a different payment",
    );
  }

  const [row] = await tx
    .select({
      paymentId: payments.id,
      paymentStatus: payments.paymentStatus,
      amount: paymentGatewayOrders.amount,
      currency: paymentGatewayOrders.currency,
      createdAt: payments.createdAt,
      invoiceId: paymentGatewayOrders.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      provider: paymentGatewayOrders.provider,
      providerOrderId: paymentGatewayOrders.providerOrderId,
      checkoutUrl: paymentGatewayOrders.metadata,
      expiresAt: paymentGatewayOrders.expiresAt,
    })
    .from(payments)
    .innerJoin(
      paymentGatewayOrders,
      and(
        eq(paymentGatewayOrders.tenantId, tenantId),
        eq(paymentGatewayOrders.paymentId, payments.id),
      ),
    )
    .innerJoin(
      invoices,
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.id, paymentGatewayOrders.invoiceId),
      ),
    )
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, existing.id)))
    .limit(1);

  if (!row) {
    // A payment idempotency key without its order means the two inserts were not
    // atomic, which the initiation transaction guarantees. Never guess a URL.
    throw AppError.internal("The original payment initiation is incomplete");
  }

  const checkoutUrl = (
    row.checkoutUrl as { readonly checkoutUrl?: unknown } | null
  )?.checkoutUrl;

  if (typeof checkoutUrl !== "string") {
    throw AppError.internal("The original payment initiation is incomplete");
  }

  recordPaymentAudit(actor.audit, "payment.initiation_replayed", {
    tenantId,
    actorUserId: actor.userId,
    paymentId: row.paymentId,
    invoiceId: row.invoiceId,
    provider: row.provider,
  });

  return {
    paymentId: row.paymentId,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    paymentStatus: row.paymentStatus,
    amount: row.amount,
    currency: row.currency,
    provider: row.provider as PaymentGatewayProviderName,
    providerOrderId: row.providerOrderId,
    checkoutUrl,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    replayed: true,
  };
}

/**
 * Initiates one online payment for an issued invoice.
 *
 * The amount is always the current outstanding balance; partial online payment
 * is a later product decision, and accepting a client amount would let a caller
 * decide how much money to request.
 */
export async function initiatePayment(
  tenantId: string,
  input: InitiatePaymentInput,
  actor: PaymentActorContext,
  dependencies: InitiatePaymentDependencies = {},
): Promise<PaymentInitiationDto> {
  const staff = assertActor(actor);
  const method = assertGatewayMethod(input.method);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  const gateway: PaymentGateway =
    dependencies.gateway ??
    (input.provider !== undefined
      ? createPaymentGateway({
          ...paymentGatewayConfigFromEnv(),
          provider: input.provider,
        })
      : getPaymentGateway());

  const requestHash = requestHashOf(input.invoiceId, method, gateway.provider);

  return withTenantTransaction(tenantId, async (tx) => {
    // Serialize retries for this tenant+key before touching the provider, so a
    // concurrent duplicate waits and then replays instead of creating a second
    // order. The lock is released with the transaction.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`payment-initiate:${tenantId}:${idempotencyKey}`}, 0))`,
    );

    const replay = await replayIfPresent(
      tx,
      tenantId,
      idempotencyKey,
      requestHash,
      staff,
    );
    if (replay) return replay;

    const [invoice] = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceStatus: invoices.invoiceStatus,
        patientId: invoices.patientId,
        branchId: invoices.branchId,
        currency: invoices.currency,
        totalAmount: invoices.totalAmount,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, input.invoiceId)))
      .limit(1);

    if (!invoice) {
      throw AppError.notFound("Invoice not found");
    }

    if (!PAYABLE_STATUSES.has(invoice.invoiceStatus)) {
      const reason =
        invoice.invoiceStatus === "DRAFT"
          ? "A draft invoice cannot be paid online; issue it first"
          : invoice.invoiceStatus === "CANCELLED"
            ? "A cancelled invoice cannot receive an online payment"
            : invoice.invoiceStatus === "PAID"
              ? "This invoice has no outstanding balance"
              : "This invoice cannot receive an online payment in its current state";

      throw AppError.conflict(reason);
    }

    // The invoice is tenant-scoped and its branch FK already proves the branch
    // exists in the tenant; this check keeps the boundary explicit in the
    // service, matching how manual recording validates it.
    await assertBranchInTenant(tx, tenantId, invoice.branchId);

    const [settledPayments, settledRefunds] = await Promise.all([
      tx
        .select({ amount: invoicePayments.amount, currency: invoicePayments.currency })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.tenantId, tenantId),
            eq(invoicePayments.invoiceId, invoice.id),
            eq(invoicePayments.paymentStatus, "SUCCESSFUL"),
          ),
        ),
      tx
        .select({ amount: invoiceRefunds.amount, currency: invoiceRefunds.currency })
        .from(invoiceRefunds)
        .where(
          and(
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.invoiceId, invoice.id),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
          ),
        ),
    ]);

    const balance = calculateInvoiceBalance({
      totalAmount: invoice.totalAmount,
      currency: invoice.currency,
      payments: settledPayments.map((row) => ({
        amount: row.amount,
        currency: row.currency,
        status: "SUCCESSFUL" as const,
      })),
      refunds: settledRefunds.map((row) => ({
        amount: row.amount,
        currency: row.currency,
        status: "SUCCESSFUL" as const,
      })),
    });

    if (compareMoney(balance.balanceDue, "0.00") <= 0) {
      throw AppError.conflict("This invoice has no outstanding balance");
    }

    const paymentId = randomUUID();

    let providerOrder: ReturnType<typeof validateGatewayOrder>;

    try {
      // Provider call is bounded by the registry timeout. It happens before any
      // insert so a failure leaves no pending payment or orphan order.
      const created = await gateway.createOrder({
        tenantId,
        paymentId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amount: balance.balanceDue,
        currency: invoice.currency,
        description: "Hospital invoice payment",
      });

      providerOrder = validateGatewayOrder(created, gateway.provider);
    } catch (error) {
      const appError = gatewayFailure(error);

      recordPaymentAudit(staff.audit, "payment.initiation_failed", {
        tenantId,
        actorUserId: staff.userId,
        invoiceId: invoice.id,
        provider: gateway.provider,
        paymentMethod: method,
        reason: appError.code,
      });

      logger.warn(
        {
          event: "payment.initiation_failed",
          tenantId,
          invoiceId: invoice.id,
          provider: gateway.provider,
          reason: appError.code,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "payment gateway initiation failed",
      );

      throw appError;
    }

    await tx.insert(payments).values({
      id: paymentId,
      tenantId,
      branchId: invoice.branchId,
      patientId: invoice.patientId,
      paymentMethod: method,
      amount: balance.balanceDue,
      currency: invoice.currency,
      // An open checkout is not money: the balance moves only after verified
      // success. The receipt is still the receipt-level record of the attempt.
      paymentStatus: "PENDING",
      reference: null,
      notes: null,
      receivedBy: staff.userId,
      idempotencyKey,
      requestHash,
    });

    // Reuses the existing payment schema to associate the attempt with the
    // invoice. An allocation alone settles nothing; `invoice_payments` is the
    // ledger that moves `amount_paid`, and it is written only on success.
    await tx.insert(paymentAllocations).values({
      tenantId,
      paymentId,
      invoiceId: invoice.id,
      amount: balance.balanceDue,
    });

    await tx.insert(paymentGatewayOrders).values({
      tenantId,
      paymentId,
      invoiceId: invoice.id,
      provider: gateway.provider,
      providerOrderId: providerOrder.orderId,
      providerTransactionReference: providerOrder.transactionReference,
      amount: balance.balanceDue,
      currency: invoice.currency,
      status: "PENDING",
      metadata: {
        ...providerOrder.metadata,
        // The client needs the URL; storing it makes a replay return the same
        // checkout instead of creating a new provider order.
        checkoutUrl: providerOrder.checkoutUrl,
      },
      expiresAt: providerOrder.expiresAt,
    });

    const [created] = await tx
      .select({ createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1);

    if (!created) {
      throw AppError.internal("Failed to persist the payment initiation");
    }

    recordPaymentAudit(staff.audit, "payment.initiated", {
      tenantId,
      actorUserId: staff.userId,
      paymentId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      branchId: invoice.branchId,
      patientId: invoice.patientId,
      paymentMethod: method,
      provider: gateway.provider,
    });

    return {
      paymentId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentStatus: "PENDING",
      amount: balance.balanceDue,
      currency: invoice.currency,
      provider: gateway.provider,
      providerOrderId: providerOrder.orderId,
      checkoutUrl: providerOrder.checkoutUrl,
      expiresAt: providerOrder.expiresAt,
      createdAt: created.createdAt,
      replayed: false,
    };
  });
}
