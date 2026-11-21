import { Router, type Request, type RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
import { getRequestActor } from "../../lib/request-context.js";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/authenticate.js";
import { getValidated, validate } from "../../middleware/validate.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import {
  clearAuthCookies,
  readAccessCredential,
  readRefreshToken,
  setAuthCookies,
} from "./auth.cookies.js";
import { csrfProtection, requireAuthenticatedUser } from "./auth.middleware.js";
import {
  acceptInvitationSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  invitationDetailsSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  resetPasswordTokenSchema,
  verifyEmailSchema,
} from "./auth.schemas.js";
import {
  acceptStaffInvitation,
  getInvitationDetails,
  resendEmailVerification,
  verifyEmailAddress,
} from "./auth.email.service.js";
import {
  buildPasswordResetRequestResponse,
  changePassword,
  getPublicUser,
  listSessions,
  loginUser,
  logout,
  logoutAll,
  refreshSession,
  inspectPasswordResetToken,
  registerUser,
  requestPasswordReset,
  resetPassword,
  type SessionMetadata,
} from "./auth.service.js";

export const authRouter: Router = Router();

/** Identity of the active sign-in attempt, for the per-account/IP throttle. */
function loginRateLimitKey(req: Request): string {
  const body: unknown = req.body;
  const identifier =
    typeof body === "object" && body !== null && "identifier" in body && typeof body.identifier === "string"
      ? body.identifier.trim().toLowerCase()
      : "unknown";

  return `${req.ip ?? req.socket.remoteAddress ?? "unknown"}|${identifier}`;
}

function sessionMetadata(req: Request): SessionMetadata {
  return {
    userAgent: req.get("user-agent") ?? null,
    ipAddress: req.ip ?? null,
  };
}

const loginRateLimiter = createRateLimiter({
  windowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_LOGIN_RATE_LIMIT_MAX,
  keyGenerator: loginRateLimitKey,
  message: "Too many sign-in attempts, please try again later",
});

/** Missing credentials are a 401; CSRF is only meaningful with a session. */
const requireRefreshCookie: RequestHandler = (req, _res, next) => {
  if (!readRefreshToken(req)) {
    next(AppError.unauthorized("Invalid or expired refresh token"));
    return;
  }

  next();
};

const forgotPasswordRateLimiter = createRateLimiter({
  windowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_LOGIN_RATE_LIMIT_MAX,
  keyGenerator: (req) => `forgot|${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  message: "Too many password reset requests, please try again later",
});

/** Public token-consuming endpoints: verification and invitation acceptance. */
const emailTokenRateLimiter = createRateLimiter({
  windowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: Math.max(20, env.AUTH_LOGIN_RATE_LIMIT_MAX * 2),
  keyGenerator: (req) => `email-token|${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  message: "Too many email link attempts, please try again later",
});

authRouter.post(
  "/register",
  validate({ body: registerSchema }),
  async (req, res) => {
    const input = getValidated<typeof registerSchema>(req, "body");
    const user = await registerUser(input);
    sendCreated(res, { user });
  },
);

authRouter.post(
  "/login",
  loginRateLimiter,
  validate({ body: loginSchema }),
  async (req, res) => {
    const input = getValidated<typeof loginSchema>(req, "body");
    const session = await loginUser(input, sessionMetadata(req));

    setAuthCookies(res, session);

    sendSuccess(res, {
      user: session.user,
      csrfToken: session.csrfToken,
    });
  },
);

authRouter.post("/refresh", requireRefreshCookie, csrfProtection, async (req, res) => {
  const refreshToken = readRefreshToken(req);

  if (!refreshToken) {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  const session = await refreshSession(refreshToken);
  setAuthCookies(res, session);

  sendSuccess(res, {
    user: session.user,
    csrfToken: session.csrfToken,
  });
});

authRouter.post("/logout", csrfProtection, async (req, res) => {
  await logout(readRefreshToken(req), readAccessCredential(req));
  clearAuthCookies(res);
  sendNoContent(res);
});

authRouter.post("/logout-all", csrfProtection, authenticate, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  await logoutAll(actor.userId);
  clearAuthCookies(res);
  sendNoContent(res);
});

authRouter.post(
  "/change-password",
  csrfProtection,
  authenticate,
  validate({ body: changePasswordSchema }),
  async (req, res) => {
    const actor = requireAuthenticatedUser();
    const input = getValidated<typeof changePasswordSchema>(req, "body");

    await changePassword(actor.userId, input);
    clearAuthCookies(res);

    sendSuccess(res, {
      message: "Password changed. Please sign in again with your new password.",
    });
  },
);

authRouter.post(
  "/email/verify",
  emailTokenRateLimiter,
  validate({ body: verifyEmailSchema }),
  async (req, res) => {
    const input = getValidated<typeof verifyEmailSchema>(req, "body");
    const result = await verifyEmailAddress(input.token);
    const user = await getPublicUser(result.userId);

    sendSuccess(res, {
      user,
      alreadyVerified: result.alreadyVerified,
    });
  },
);

authRouter.post("/email/resend", authenticate, csrfProtection, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const result = await resendEmailVerification(actor.userId);

  sendSuccess(
    res,
    {
      status: result.status,
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    },
    202,
  );
});

authRouter.post(
  "/invitations/details",
  emailTokenRateLimiter,
  validate({ body: invitationDetailsSchema }),
  async (req, res) => {
    const input = getValidated<typeof invitationDetailsSchema>(req, "body");
    const invitation = await getInvitationDetails(input.token);

    sendSuccess(res, { invitation });
  },
);

authRouter.post(
  "/invitations/accept",
  emailTokenRateLimiter,
  validate({ body: acceptInvitationSchema }),
  async (req, res) => {
    const input = getValidated<typeof acceptInvitationSchema>(req, "body");
    const result = await acceptStaffInvitation(input.token, {
      fullName: input.fullName,
      password: input.password,
    });
    const user = await getPublicUser(result.userId);

    sendSuccess(res, {
      user,
      tenantId: result.tenantId,
      membershipId: result.membershipId,
      accountCreated: result.accountCreated,
    });
  },
);

authRouter.post(
  "/forgot-password",
  forgotPasswordRateLimiter,
  validate({ body: forgotPasswordSchema }),
  async (req, res) => {
    const input = getValidated<typeof forgotPasswordSchema>(req, "body");
    const result = await requestPasswordReset(input);

    // The response is identical for known and unknown accounts: no delivery
    // status, token or timing hint. Production never includes token material.
    // Development additionally returns an explicit safe reset-link action so
    // the recovery UI can be exercised without an email provider.
    sendSuccess(res, buildPasswordResetRequestResponse(result), 202);
  },
);

authRouter.post(
  "/reset-password/validate",
  emailTokenRateLimiter,
  validate({ body: resetPasswordTokenSchema }),
  async (req, res) => {
    const input = getValidated<typeof resetPasswordTokenSchema>(req, "body");
    const inspection = await inspectPasswordResetToken(input.token);

    sendSuccess(res, {
      valid: inspection.status === "VALID",
      status: inspection.status,
      ...(inspection.expiresAt === null
        ? {}
        : { expiresAt: inspection.expiresAt.toISOString() }),
    });
  },
);

authRouter.post(
  "/reset-password",
  validate({ body: resetPasswordSchema }),
  async (req, res) => {
    const input = getValidated<typeof resetPasswordSchema>(req, "body");

    await resetPassword(input.token, input.password);
    clearAuthCookies(res);

    sendSuccess(res, {
      message: "Password reset. Please sign in with your new password.",
    });
  },
);

authRouter.get("/me", authenticate, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const user = await getPublicUser(actor.userId);
  const requestActor = getRequestActor();

  sendSuccess(res, {
    user,
    sessionId: actor.sessionId,
    plane: requestActor?.kind ?? "user",
    activeTenant:
      requestActor?.kind === "tenant"
        ? {
            id: requestActor.tenantId,
            slug: requestActor.tenantSlug,
            roles: requestActor.roles,
            permissions: [...requestActor.permissions],
          }
        : null,
  });
});

authRouter.get("/sessions", authenticate, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const sessions = await listSessions(actor.userId, actor.sessionId);

  sendSuccess(res, { sessions });
});
