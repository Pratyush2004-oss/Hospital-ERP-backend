import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/http-error.js";

/**
 * Fixed-window rate limiter.
 *
 * State is per process, which is the right default for a single API instance;
 * once the API runs on several nodes this must move to the shared Redis
 * infrastructure (the middleware contract stays the same).
 */

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum requests allowed per key per window. */
  readonly max: number;
  /** Defaults to the client IP (Express `trust proxy` aware). */
  readonly keyGenerator?: (req: Request) => string;
  /** Requests that should not consume a slot, e.g. health probes. */
  readonly skip?: (req: Request) => boolean;
  readonly message?: string;
}

interface Counter {
  count: number;
  resetAt: number;
}

const SWEEP_THRESHOLD = 5_000;

function defaultKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const counters = new Map<string, Counter>();
  const keyGenerator = options.keyGenerator ?? defaultKey;
  const message = options.message ?? "Too many requests, please try again later";

  function sweep(now: number): void {
    if (counters.size < SWEEP_THRESHOLD) return;

    for (const [key, counter] of counters) {
      if (counter.resetAt <= now) counters.delete(key);
    }
  }

  return (req, res, next) => {
    if (options.skip?.(req)) {
      next();
      return;
    }

    const now = Date.now();
    sweep(now);

    const key = keyGenerator(req);
    const existing = counters.get(key);

    const counter: Counter =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };

    counter.count += 1;
    counters.set(key, counter);

    const remaining = Math.max(0, options.max - counter.count);
    const resetSeconds = Math.max(0, Math.ceil((counter.resetAt - now) / 1000));

    res.setHeader("RateLimit-Limit", options.max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetSeconds);

    if (counter.count > options.max) {
      res.setHeader("Retry-After", resetSeconds);
      next(AppError.tooManyRequests(message));
      return;
    }

    next();
  };
}
