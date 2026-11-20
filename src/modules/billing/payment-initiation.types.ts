import type { BillingAuditSink } from "./billing.audit.js";
import type {
  PaymentGateway,
  PaymentGatewayProviderName,
} from "./gateway/payment-gateway.types.js";
import type { PaymentStatus } from "./payment.types.js";

/**
 * Online payment initiation contracts (Task 19.6.1).
 *
 * The client supplies only the invoice, tender type and an idempotency key. The
 * amount, currency, patient and branch are derived from the invoice inside the
 * transaction, so a forged amount or status can never become authoritative.
 */

/** Tender types that make sense for a provider-hosted checkout. */
export type GatewayPaymentMethod = "CARD" | "UPI" | "BANK_TRANSFER" | "OTHER";

export interface InitiatePaymentInput {
  readonly invoiceId: string;
  readonly method: GatewayPaymentMethod;
  /** Optional registry key; defaults to `PAYMENT_GATEWAY_PROVIDER`. */
  readonly provider?: PaymentGatewayProviderName;
  /** Required client retry key, unique per tenant. */
  readonly idempotencyKey: string;
}

/** Minimal checkout information returned to the authenticated client. */
export interface PaymentInitiationDto {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly paymentStatus: PaymentStatus;
  readonly amount: string;
  readonly currency: string;
  readonly provider: PaymentGatewayProviderName;
  readonly providerOrderId: string;
  readonly checkoutUrl: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  /** `true` when the idempotency key replayed an existing open order. */
  readonly replayed: boolean;
}

/** Injection seams for tests; production uses the registry singleton. */
export interface InitiatePaymentDependencies {
  readonly gateway?: PaymentGateway;
  readonly audit?: BillingAuditSink;
}
