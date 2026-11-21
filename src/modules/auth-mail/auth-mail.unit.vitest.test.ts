import { afterEach, describe, expect, it, vi } from "vitest";
import { authMailConfigurationIssues } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import {
  AuthMailProviderError,
  clearMockAuthMailOutbox,
  createMockAuthMailProvider,
  createNoneAuthMailProvider,
  createResendAuthMailProvider,
  mockAuthMailOutbox,
} from "./auth-mail.providers.js";
import {
  buildAuthMailActionUrl,
  buildAuthMailPageUrl,
  sendAuthMail,
} from "./auth-mail.service.js";
import { escapeHtml, renderAuthMailTemplate } from "./auth-mail.templates.js";
import type { AuthMailMessage } from "./auth-mail.types.js";

const message: AuthMailMessage = {
  to: "recipient@example.test",
  kind: "EMAIL_VERIFICATION",
  subject: "Subject",
  html: "<p>html</p>",
  text: "text",
};

afterEach(() => {
  clearMockAuthMailOutbox();
});

describe("auth mail provider modes", () => {
  it("records deterministic mock delivery in the shared outbox", async () => {
    const provider = createMockAuthMailProvider();

    const result = await provider.send(message);

    expect(result.messageId).toMatch(/^mock-auth-mail-/);
    expect(mockAuthMailOutbox).toHaveLength(1);
    expect(mockAuthMailOutbox[0]?.to).toBe("recipient@example.test");
  });

  it("supports deterministic transient and permanent mock failures", async () => {
    const transient = createMockAuthMailProvider({ fail: "transient" });
    const permanent = createMockAuthMailProvider({ fail: "permanent" });

    await expect(transient.send(message)).rejects.toMatchObject({ transient: true });
    await expect(permanent.send(message)).rejects.toMatchObject({ transient: false });
    expect(mockAuthMailOutbox).toHaveLength(0);
  });

  it("rejects delivery when no provider is configured", async () => {
    const provider = createNoneAuthMailProvider();

    await expect(provider.send(message)).rejects.toBeInstanceOf(AuthMailProviderError);
    await expect(provider.send(message)).rejects.toMatchObject({
      code: "auth_mail_provider_not_configured",
      transient: false,
    });
  });

  it("sends through Resend with the configured credential and sender", async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      return new Response(JSON.stringify({ id: "resend-message-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = createResendAuthMailProvider({
      apiKey: "re_test_key_123456",
      fromEmail: "no-reply@hospitalos.com",
      fromName: "HospitalOS",
      replyTo: "support@hospitalos.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.send(message);

    expect(result.messageId).toBe("resend-message-1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer re_test_key_123456",
      "content-type": "application/json",
    });

    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body.from).toBe("HospitalOS <no-reply@hospitalos.com>");
    expect(body.to).toEqual(["recipient@example.test"]);
    expect(body.reply_to).toBe("support@hospitalos.com");
    expect(body.html).toBe("<p>html</p>");
    expect(body.text).toBe("text");
  });

  it("maps provider responses to safe transient/permanent error codes", async () => {
    const rateLimited = createResendAuthMailProvider({
      apiKey: "re_test_key_123456",
      fromEmail: "no-reply@hospitalos.com",
      fromName: "HospitalOS",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ name: "rate_limit_exceeded" }), {
          status: 429,
        })) as unknown as typeof fetch,
    });

    const rejected = createResendAuthMailProvider({
      apiKey: "re_test_key_123456",
      fromEmail: "no-reply@hospitalos.com",
      fromName: "HospitalOS",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ name: "validation_error" }), {
          status: 422,
        })) as unknown as typeof fetch,
    });

    await expect(rateLimited.send(message)).rejects.toMatchObject({
      code: "auth_mail_rate_limit_exceeded",
      transient: true,
    });
    await expect(rejected.send(message)).rejects.toMatchObject({
      code: "auth_mail_validation_error",
      transient: false,
    });
  });

  it("reports a delivery failure without throwing or logging the token", async () => {
    const provider = createMockAuthMailProvider({ fail: "permanent" });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const warn = vi.spyOn(logger, "warn");

    const result = await sendAuthMail(
      {
        to: "recipient@example.test",
        recipientName: "Test User",
        kind: "PASSWORD_RESET",
        token: "super-secret-token-value",
        expiresAt,
      },
      { provider },
    );

    expect(result).toMatchObject({
      status: "FAILED",
      mode: "mock",
      errorCode: "mock_permanent_failure",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-token-value");
    expect(JSON.stringify(result)).not.toContain("super-secret-token-value");
  });

  it("suppresses delivery with the none adapter instead of throwing", async () => {
    const result = await sendAuthMail(
      {
        to: "recipient@example.test",
        recipientName: "Test User",
        kind: "EMAIL_VERIFICATION",
        token: "super-secret-token-value",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      { provider: createNoneAuthMailProvider() },
    );

    expect(result).toEqual({ status: "SUPPRESSED", mode: "none", messageId: null });
  });
});

describe("auth mail templates and links", () => {
  it("renders branded HTML and text with an escaped recipient name", () => {
    const rendered = renderAuthMailTemplate("STAFF_INVITATION", {
      recipientName: "<img src=x onerror=alert(1)>",
      actionUrl: "https://app.hospitalos.com/accept-invitation?token=abc123",
      expiresIn: "7 days",
      hospitalName: "City Hospital",
      inviterName: "Dr. Ada",
    });

    expect(rendered.subject).toContain("invited");
    expect(rendered.html).toContain("HospitalOS");
    expect(rendered.html).toContain("City Hospital");
    expect(rendered.html).toContain("https://app.hospitalos.com/accept-invitation?token=abc123");
    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.text).toContain("Accept invitation");
    expect(rendered.text).toContain("expires in 7 days");
  });

  it("uses FRONTEND_URL for the action link and encodes the token", () => {
    const url = buildAuthMailActionUrl(
      "PASSWORD_RESET",
      "token with spaces/+",
      "https://app.hospitalos.com/",
    );

    expect(url).toBe(
      "https://app.hospitalos.com/reset-password?token=token+with+spaces%2F%2B",
    );
  });

  it("renders a non-token hospital activation notice", () => {
    const actionUrl = buildAuthMailPageUrl(
      "HOSPITAL_ACTIVATED",
      { tenant: "st-marys-general" },
      "https://app.hospitalos.com",
    );
    const rendered = renderAuthMailTemplate("HOSPITAL_ACTIVATED", {
      recipientName: "Dr. Ada",
      actionUrl,
      hospitalName: "St. Mary's General",
    });

    expect(actionUrl).toBe(
      "https://app.hospitalos.com/onboarding/status?tenant=st-marys-general",
    );
    expect(rendered.subject).toContain("active");
    expect(rendered.html).toContain("St. Mary&#39;s General");
    expect(rendered.html).toContain("Continue setup");
    expect(rendered.text).toContain("St. Mary's General");
    expect(rendered.text).not.toContain("single-use link");
    expect(rendered.text).not.toContain("token=");
  });

  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("production auth mail configuration guard", () => {
  const base = {
    fromEmail: "no-reply@hospitalos.com",
    apiKey: "re_test_key_123456",
    frontendUrl: "https://app.hospitalos.com",
  } as const;

  it("rejects mock and none in production", () => {
    expect(
      authMailConfigurationIssues({ ...base, nodeEnv: "production", provider: "mock" }),
    ).toHaveLength(1);
    expect(
      authMailConfigurationIssues({ ...base, nodeEnv: "production", provider: "none" }),
    ).toHaveLength(1);
  });

  it("requires a real provider key and a non-placeholder sender", () => {
    expect(
      authMailConfigurationIssues({
        nodeEnv: "production",
        provider: "real",
        fromEmail: "no-reply@hospitalos.com",
        apiKey: undefined,
      }),
    ).toContain("AUTH_MAIL_RESEND_API_KEY is required when AUTH_MAIL_PROVIDER=real");

    expect(
      authMailConfigurationIssues({
        nodeEnv: "production",
        provider: "real",
        fromEmail: "no-reply@hospitalos.invalid",
        apiKey: "re_test_key_123456",
      }),
    ).toContain(
      "AUTH_MAIL_FROM_EMAIL must use a verified sender domain when AUTH_MAIL_PROVIDER=real",
    );
  });

  it("rejects a localhost frontend origin in production", () => {
    expect(
      authMailConfigurationIssues({
        ...base,
        nodeEnv: "production",
        provider: "real",
        frontendUrl: "http://localhost:3000",
      }),
    ).toContain(
      "FRONTEND_URL must be the production web origin so authentication email links resolve",
    );
  });

  it("allows mock delivery only outside production", () => {
    expect(
      authMailConfigurationIssues({ ...base, nodeEnv: "test", provider: "mock" }),
    ).toHaveLength(0);
    expect(
      authMailConfigurationIssues({
        ...base,
        nodeEnv: "production",
        provider: "real",
      }),
    ).toHaveLength(0);
  });
});
