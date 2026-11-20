import { env } from "../../../config/env.js";
import { createMockPaymentGateway } from "./mock-payment-gateway.provider.js";
import {
  PaymentGatewayTimeoutError,
  type GatewayCheckoutOrderRequest,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentGateway,
  type PaymentGatewayConfig,
  type PaymentGatewayProviderName,
} from "./payment-gateway.types.js";

/**
 * Gateway adapter registry (Task 19.6.1).
 *
 * Adding a provider is deliberately small:
 *   1. implement `PaymentGateway` in its own file;
 *   2. add its key to `PaymentGatewayProviderName` and this factory map;
 *   3. extend `PAYMENT_GATEWAY_PROVIDER` in `config/env.ts` and document its
 *      secret env var.
 *
 * Core billing never imports `mock-payment-gateway.provider.ts` or a concrete
 * adapter; it calls `getPaymentGateway()` (or an injected `PaymentGateway` in
 * tests) and only sees the generic contract.
 */

type GatewayFactory = (config: PaymentGatewayConfig) => PaymentGateway;

const GATEWAY_FACTORIES: Readonly<Record<PaymentGatewayProviderName, GatewayFactory>> = {
  mock: createMockPaymentGateway,
};

/** Resolves runtime configuration from the already-validated environment. */
export function paymentGatewayConfigFromEnv(): PaymentGatewayConfig {
  return {
    provider: env.PAYMENT_GATEWAY_PROVIDER,
    timeoutMs: env.PAYMENT_GATEWAY_TIMEOUT_MS,
    checkoutBaseUrl: env.PAYMENT_GATEWAY_CHECKOUT_BASE_URL,
    ...(env.PAYMENT_GATEWAY_API_KEY !== undefined
      ? { apiKey: env.PAYMENT_GATEWAY_API_KEY }
      : {}),
  };
}

/**
 * Applies the configured deadline to one provider call. A hung adapter cannot
 * hold the initiation transaction open indefinitely; the service maps the
 * timeout to a 504 without exposing provider internals.
 */
export function withGatewayTimeout<T>(
  order: Promise<T>,
  provider: PaymentGatewayProviderName,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PaymentGatewayTimeoutError(provider, timeoutMs));
    }, timeoutMs);

    // The timer must not keep the process alive on its own.
    timer.unref?.();

    order.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Builds a gateway from explicit configuration. Tests may use this with an
 * injected adapter instead; the returned gateway always enforces the timeout.
 */
export function createPaymentGateway(config: PaymentGatewayConfig): PaymentGateway {
  const factory = GATEWAY_FACTORIES[config.provider];

  if (!factory) {
    throw new Error(`Unsupported payment gateway provider: ${config.provider}`);
  }

  const adapter = factory(config);

  return {
    provider: adapter.provider,
    createOrder(request: GatewayCheckoutOrderRequest) {
      return withGatewayTimeout(
        adapter.createOrder(request),
        adapter.provider,
        config.timeoutMs,
      );
    },
    refund(request: GatewayRefundRequest): Promise<GatewayRefundResult> {
      return withGatewayTimeout(
        adapter.refund(request),
        adapter.provider,
        config.timeoutMs,
      );
    },
  };
}

let cachedGateway: PaymentGateway | undefined;

/**
 * Process-wide default gateway. The adapter holds no per-request state, so a
 * singleton is safe; tests that need to simulate failures pass `gateway` to
 * `initiatePayment` instead of mutating this.
 */
export function getPaymentGateway(): PaymentGateway {
  cachedGateway ??= createPaymentGateway(paymentGatewayConfigFromEnv());
  return cachedGateway;
}
