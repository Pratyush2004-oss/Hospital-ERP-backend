/**
 * Provider-independent payment gateway contracts (Task 19.6.1).
 *
 * Core billing (`payment-initiation.service.ts`) imports only these types. A
 * provider adapter translates them into its own HTTP API; adding a real
 * provider means adding an adapter and a registry key, not touching payment
 * validation, persistence or the invoice lifecycle.
 *
 * Money stays a fixed 2-decimal string, the same form used by every billing
 * column. Provider SDKs must never be imported outside their adapter.
 */

/** Registry key of a provider. `mock` is the deterministic dev/test adapter. */
export type PaymentGatewayProviderName = "mock";

/** JSON-safe values allowed in non-secret provider metadata. */
export type PaymentGatewayMetadataValue = string | number | boolean | null;

/**
 * Everything an adapter needs to create a checkout order. It contains no
 * patient name, contact detail, credential or card data; the provider only
 * needs identifiers and money.
 */
export interface GatewayCheckoutOrderRequest {
  readonly tenantId: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** Amount to collect, as a fixed 2-decimal string. */
  readonly amount: string;
  readonly currency: string;
  /** Short non-identifying description shown by the provider, e.g. "Hospital invoice". */
  readonly description: string;
}

/** Normalized result of creating a provider order. */
export interface GatewayCheckoutOrder {
  readonly provider: PaymentGatewayProviderName;
  /** Provider-side order/checkout id. Persisted and unique per tenant+provider. */
  readonly orderId: string;
  /** Provider transaction reference when available at initiation. */
  readonly transactionReference: string | null;
  /** URL the authenticated client may open to complete payment. */
  readonly checkoutUrl: string;
  /** Provider checkout expiry, when it supplies one. */
  readonly expiresAt: Date | null;
  /** Non-secret provider metadata; credentials must never be returned here. */
  readonly metadata: Readonly<Record<string, PaymentGatewayMetadataValue>>;
}

/** Provider outcome of one refund call (Phase 19.7.1). */
export type GatewayRefundStatus = "SUCCESSFUL" | "PENDING" | "FAILED";

/**
 * Everything an adapter needs to reverse a capture. The amount and currency
 * are always the values validated against the stored payment; they are not
 * accepted from the refund requester.
 */
export interface GatewayRefundRequest {
  readonly tenantId: string;
  readonly refundId: string;
  readonly paymentId: string;
  readonly providerOrderId: string;
  readonly providerTransactionReference: string | null;
  readonly amount: string;
  readonly currency: string;
  /** Free-text operational reason; never card data or credentials. */
  readonly reason?: string | null;
}

/** Normalized provider refund result. `PENDING` is not success. */
export interface GatewayRefundResult {
  readonly provider: PaymentGatewayProviderName;
  /** Provider-side refund id. Persisted and unique per tenant + provider. */
  readonly refundId: string;
  readonly status: GatewayRefundStatus;
  readonly transactionReference: string | null;
}

/**
 * One adapter implementation. `createOrder` and `refund` must be side-effect
 * safe to retry with the same request: the services use idempotency keys and
 * persisted provider ids, so a replay never triggers a second money movement.
 */
export interface PaymentGateway {
  readonly provider: PaymentGatewayProviderName;
  createOrder(request: GatewayCheckoutOrderRequest): Promise<GatewayCheckoutOrder>;
  refund(request: GatewayRefundRequest): Promise<GatewayRefundResult>;
}

/** Runtime configuration resolved from validated environment variables. */
export interface PaymentGatewayConfig {
  readonly provider: PaymentGatewayProviderName;
  readonly timeoutMs: number;
  readonly checkoutBaseUrl: string;
  /** Never logged, persisted or returned to a client. */
  readonly apiKey?: string;
}

/** Provider did not answer within the configured timeout. */
export class PaymentGatewayTimeoutError extends Error {
  readonly provider: PaymentGatewayProviderName;

  constructor(provider: PaymentGatewayProviderName, timeoutMs: number) {
    super(`Payment gateway ${provider} timed out after ${timeoutMs}ms`);
    this.name = "PaymentGatewayTimeoutError";
    this.provider = provider;
  }
}

/**
 * Provider rejected order creation or returned an unusable response. The
 * message must be safe to log: adapters never put credentials, request bodies
 * or provider payloads in it.
 */
export class PaymentGatewayRequestError extends Error {
  readonly provider: PaymentGatewayProviderName;

  constructor(provider: PaymentGatewayProviderName, message: string) {
    super(message);
    this.name = "PaymentGatewayRequestError";
    this.provider = provider;
  }
}
