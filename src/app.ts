import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { openApiDocument } from "./docs/openapi.js";
import { logger, redactPaths } from "./lib/logger.js";
import { installAuthentication } from "./modules/auth/auth.middleware.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { captureRequestMetadata } from "./middleware/request-metadata.js";
import { apiRouter } from "./routes/index.js";

/** Requests larger than this are rejected with 413 before touching handlers. */
const JSON_BODY_LIMIT = "1mb";

/**
 * Builds the Express application without binding a port, so tests and workers
 * can create isolated instances.
 */
export function createApp(): Express {
  const app = express();

  // Install the auth resolver before any route can use `authenticate`.
  installAuthentication();

  app.disable("x-powered-by");
  // Single reverse proxy (load balancer / ingress) in front of the API.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without an Origin header (probes, server-to-server) pass
        // through. Browser origins must match the primary frontend URL or an
        // explicit preview/production allow-list.
        const allowedOrigins = new Set([
          env.FRONTEND_URL,
          ...env.CORS_ALLOWED_ORIGINS,
        ]);
        const isAllowed = origin === undefined || allowedOrigins.has(origin);
        callback(null, isAllowed);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const header = req.headers["x-request-id"];
        const id = typeof header === "string" && header.length > 0 ? header : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      autoLogging: {
        ignore: (req) => req.url === `${env.API_PREFIX}/health`,
      },
      // pino-http installs its own serializers, so the trimmed request/response
      // shapes must be configured here as well as on the base logger.
      serializers: {
        req(req) {
          return {
            id: typeof req.id === "string" ? req.id : String(req.id ?? ""),
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
      redact: {
        paths: [...redactPaths],
        remove: true,
      },
    }),
  );

  // Bind audit/correlation metadata before authentication can replace the
  // actor. Unauthenticated requests (login, registration) are auditable too.
  app.use(captureRequestMetadata);

  app.use(
    createRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      // Health probes must keep answering when a client is throttled.
      skip: (req) => req.path === `${env.API_PREFIX}/health`,
    }),
  );

  app.use(env.API_PREFIX, apiRouter);

  // Interactive API reference. Swagger UI injects its own inline bootstrap
  // script and styles, so the strict default Helmet CSP is relaxed for this
  // documentation path only.
  const docsPath = `${env.API_PREFIX}/docs`;
  app.get(`${docsPath}/openapi.json`, (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(docsPath, (_req, res, next) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    );
    next();
  });
  app.use(docsPath, swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
