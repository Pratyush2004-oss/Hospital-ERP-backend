import { randomUUID } from "node:crypto";
import type {
  GatewayCheckoutOrder,
  GatewayCheckoutOrderRequest,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentGateway,
  PaymentGatewayConfig,
} from "./payment-gateway.types.js";

/**
 * Deterministic, offline gateway adapter for development and tests (Task
 * 19.6.1).
 *
 * It creates a realistic checkout order without contacting any network or
 * requiring credentials. The order id and transaction reference are random
 * UUIDs so uniqueness constraints are exercised for real, and the checkout URL
 * points at an `.invalid` sandbox base unless the environment overrides it.
 *
 * It deliberately has no failure mode: provider failures are injected in tests
 * through the `PaymentGateway` interface, exactly as a real adapter's timeout or
 * rejection would surface. Refunds are likewise deterministic: the mock
 * acknowledges every refund synchronously as SUCCESSFUL.
 */
export function createMockPaymentGateway(config: PaymentGatewayConfig): PaymentGateway {
  return {
    provider: "mock",
    async createOrder(request: GatewayCheckoutOrderRequest): Promise<GatewayCheckoutOrder> {
      const token = randomUUID().replaceAll("-", "");
      const orderId = `mock_order_${token}`;
      const base = config.checkoutBaseUrl.replace(/\/+$/, "");

      return {
        provider: "mock",
        orderId,
        transactionReference: `mock_txn_${token}`,
        checkoutUrl: `${base}/${orderId}`,
        // Fifteen minutes is a realistic checkout window for a sandbox order.
        expiresAt: new Date(Date.now() + 15 * 60_000),
        metadata: {
          mode: "mock",
          // Non-identifying amount echo, useful when reconciling sandbox calls.
          amount: request.amount,
          currency: request.currency,
        },
      };
    },
    async refund(_request: GatewayRefundRequest): Promise<GatewayRefundResult> {
      const token = randomUUID().replaceAll("-", "");

      return {
        provider: "mock",
        refundId: `mock_refund_${token}`,
        status: "SUCCESSFUL",
        transactionReference: `mock_rtxn_${token}`,
      };
    },
  };
}
