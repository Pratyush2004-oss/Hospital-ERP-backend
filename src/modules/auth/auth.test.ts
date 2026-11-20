import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../../app.js";
import { closePool } from "../../database/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

const API = "/api/v1/auth";
const PASSWORD = "Correct-Horse-Battery-9";
const NEW_PASSWORD = "Battery-Staple-Anchor-7";

let api: TestApi;

function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

function uniquePhone(): string {
  const suffix = Math.floor(Math.random() * 10_000_000)
    .toString()
    .padStart(7, "0");
  return `+1555${suffix}`;
}

interface UserBody {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
}

interface DataBody<T> {
  data: T;
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as DataBody<T>).data;
}

function errorCode(response: TestResponse): string {
  return (response.body as { error: { code: string } }).error.code;
}

async function registerUser(overrides: {
  email?: string;
  phone?: string;
  password?: string;
  fullName?: string;
} = {}): Promise<{ email: string; phone?: string; response: TestResponse }> {
  const email = overrides.email ?? uniqueEmail();
  const phone = overrides.phone;

  const response = await api.post(`${API}/register`, {
    body: {
      fullName: overrides.fullName ?? "Test Clinician",
      email,
      ...(phone === undefined ? {} : { phone }),
      password: overrides.password ?? PASSWORD,
    },
  });

  return { email, phone, response };
}

async function login(identifier: string, password = PASSWORD): Promise<TestResponse> {
  return api.post(`${API}/login`, { body: { identifier, password } });
}

before(async () => {
  api = await createTestApi(createApp());
});

after(async () => {
  await api.close();
  await closePool();
  await closeTestAdminPool();
});

beforeEach(async () => {
  api.jar.clear();
  await getTestAdminPool().query(
    `TRUNCATE TABLE
       auth_refresh_tokens,
       auth_sessions,
       password_reset_tokens,
       tenant_memberships,
       membership_roles,
       users
     RESTART IDENTITY CASCADE`,
  );
});

describe("POST /auth/register", () => {
  it("creates an account and normalizes the email", async () => {
    const email = uniqueEmail();
    const response = await api.post(`${API}/register`, {
      body: {
        fullName: "  Ada Lovelace  ",
        email: `  ${email.toUpperCase()}  `,
        password: PASSWORD,
      },
    });

    assert.equal(response.status, 201);
    const { user } = dataOf<{ user: UserBody }>(response);
    assert.equal(user.email, email);
    assert.equal(user.fullName, "Ada Lovelace");
    assert.equal(user.isActive, true);
    assert.equal("passwordHash" in user, false);
    assert.doesNotMatch(JSON.stringify(response.body), /passwordHash|password_hash/);
  });

  it("rejects a duplicate email case-insensitively", async () => {
    const email = uniqueEmail();
    const first = await registerUser({ email });
    assert.equal(first.response.status, 201);

    const duplicate = await registerUser({ email: email.toUpperCase() });
    assert.equal(duplicate.response.status, 409);
    assert.equal(errorCode(duplicate.response), "CONFLICT");
  });

  it("rejects a duplicate phone number", async () => {
    const phone = uniquePhone();
    const first = await registerUser({ phone });
    assert.equal(first.response.status, 201);

    const duplicate = await registerUser({ phone });
    assert.equal(duplicate.response.status, 409);
  });

  it("rejects weak passwords", async () => {
    const response = await api.post(`${API}/register`, {
      body: {
        fullName: "Weak Password",
        email: uniqueEmail(),
        password: "short",
      },
    });

    assert.equal(response.status, 422);
    assert.equal(errorCode(response), "VALIDATION_ERROR");
  });

  it("rejects invalid email addresses", async () => {
    const response = await api.post(`${API}/register`, {
      body: {
        fullName: "Invalid Email",
        email: "not-an-email",
        password: PASSWORD,
      },
    });

    assert.equal(response.status, 422);
    assert.equal(errorCode(response), "VALIDATION_ERROR");
  });
});

describe("POST /auth/login", () => {
  it("signs in by email with secure HTTP-only cookies", async () => {
    const { email } = await registerUser();
    const response = await login(email);

    assert.equal(response.status, 200);
    const { user } = dataOf<{ user: UserBody }>(response);
    assert.equal(user.email, email);

    const accessCookie = response.setCookies.find((cookie) => cookie.startsWith("hos_access="));
    const refreshCookie = response.setCookies.find((cookie) => cookie.startsWith("hos_refresh="));
    const csrfCookie = response.setCookies.find((cookie) => cookie.startsWith("hos_csrf="));

    assert.ok(accessCookie, "access cookie is set");
    assert.ok(refreshCookie, "refresh cookie is set");
    assert.ok(csrfCookie, "csrf cookie is set");
    assert.match(accessCookie, /HttpOnly/i);
    assert.match(refreshCookie, /HttpOnly/i);
    assert.doesNotMatch(csrfCookie, /HttpOnly/i);
    assert.match(accessCookie, /SameSite=Lax/i);
    assert.match(refreshCookie, /Path=\/api\/v1\/auth/i);
    assert.equal(api.jar.get("hos_access")?.length! > 20, true);
    assert.equal(api.jar.get("hos_refresh")?.length! > 20, true);
  });

  it("signs in by phone number", async () => {
    const phone = uniquePhone();
    await registerUser({ phone });

    const response = await login(phone);
    assert.equal(response.status, 200);
    assert.equal(dataOf<{ user: UserBody }>(response).user.phone, phone);
  });

  it("rejects a wrong password with a generic error", async () => {
    const { email } = await registerUser();
    const response = await login(email, "Definitely-Not-The-Password-1");

    assert.equal(response.status, 401);
    assert.equal(errorCode(response), "UNAUTHORIZED");
  });

  it("rejects an unknown account with the same generic error", async () => {
    const response = await login(uniqueEmail());
    assert.equal(response.status, 401);
    assert.equal(errorCode(response), "UNAUTHORIZED");
  });

  it("rejects a disabled account", async () => {
    const { email } = await registerUser();
    await getTestAdminPool().query(
      "update users set is_active = false where lower(email) = lower($1)",
      [email],
    );

    const response = await login(email);
    assert.equal(response.status, 401);
  });
});

describe("GET /auth/me", () => {
  it("returns the signed-in account", async () => {
    const { email, response: registration } = await registerUser();
    assert.equal(registration.status, 201);

    await login(email);
    const response = await api.get(`${API}/me`);

    assert.equal(response.status, 200);
    const body = dataOf<{ user: UserBody; sessionId: string }>(response);
    assert.equal(body.user.email, email);
    assert.ok(body.sessionId);
    assert.equal("passwordHash" in body.user, false);
  });

  it("rejects requests without credentials", async () => {
    const response = await api.get(`${API}/me`);
    assert.equal(response.status, 401);
  });

  it("rejects an invalid access token", async () => {
    const response = await api.get(`${API}/me`, {
      bearer: "not-a-valid-jwt",
    });

    assert.equal(response.status, 401);
  });
});

describe("POST /auth/refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const { email } = await registerUser();
    await login(email);

    const oldRefresh = api.jar.get("hos_refresh");
    const oldAccess = api.jar.get("hos_access");
    assert.ok(oldRefresh);
    assert.ok(oldAccess);

    const response = await api.post(`${API}/refresh`);

    assert.equal(response.status, 200);
    assert.notEqual(api.jar.get("hos_refresh"), oldRefresh);
    assert.notEqual(api.jar.get("hos_access"), oldAccess);

    const me = await api.get(`${API}/me`);
    assert.equal(me.status, 200);
  });

  it("stores only SHA-256 hashes of refresh tokens", async () => {
    const { email } = await registerUser();
    await login(email);
    const rawToken = api.jar.get("hos_refresh");
    assert.ok(rawToken);

    const result = await getTestAdminPool().query<{ token_hash: string }>(
      "select token_hash from auth_refresh_tokens",
    );

    assert.equal(result.rowCount, 1);
    assert.match(result.rows[0]!.token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(result.rows[0]!.token_hash, rawToken);
  });

  it("detects reuse of a rotated token and revokes the session", async () => {
    const { email } = await registerUser();
    await login(email);

    const oldRefresh = api.jar.get("hos_refresh");
    const oldCsrf = api.jar.get("hos_csrf");
    assert.ok(oldRefresh);
    assert.ok(oldCsrf);

    const rotated = await api.post(`${API}/refresh`);
    assert.equal(rotated.status, 200);

    const reuse = await api.post(`${API}/refresh`, {
      cookie: `hos_refresh=${oldRefresh}; hos_csrf=${oldCsrf}`,
      headers: { "x-csrf-token": oldCsrf },
    });

    assert.equal(reuse.status, 401);

    // The replacement token is revoked as part of theft response.
    const afterReuse = await api.post(`${API}/refresh`);
    assert.equal(afterReuse.status, 401);
  });

  it("rejects a request without a refresh cookie", async () => {
    const response = await api.post(`${API}/refresh`, { csrf: false });
    assert.equal(response.status, 401);
  });
});

describe("POST /auth/logout and /auth/logout-all", () => {
  it("requires a valid CSRF header for cookie-authenticated requests", async () => {
    const { email } = await registerUser();
    await login(email);

    const response = await api.post(`${API}/logout`, { csrf: false });
    assert.equal(response.status, 403);
    assert.equal(errorCode(response), "FORBIDDEN");

    const me = await api.get(`${API}/me`);
    assert.equal(me.status, 200);
  });

  it("does not let a stray bearer header bypass CSRF for cookie requests", async () => {
    const { email } = await registerUser();
    await login(email);

    const access = api.jar.get("hos_access");
    const refresh = api.jar.get("hos_refresh");
    const csrf = api.jar.get("hos_csrf");
    assert.ok(access && refresh && csrf);

    const response = await api.post(`${API}/logout`, {
      csrf: false,
      cookie: `hos_access=${access}; hos_refresh=${refresh}; hos_csrf=${csrf}`,
      headers: { authorization: "Bearer not-a-real-token" },
    });

    assert.equal(response.status, 403);
  });

  it("revokes the current session and clears cookies", async () => {
    const { email } = await registerUser();
    await login(email);
    const accessToken = api.jar.get("hos_access");
    assert.ok(accessToken);

    const response = await api.post(`${API}/logout`);
    assert.equal(response.status, 204);
    assert.equal(api.jar.get("hos_access"), undefined);
    assert.equal(api.jar.get("hos_refresh"), undefined);

    const me = await api.get(`${API}/me`, {
      cookie: `hos_access=${accessToken}`,
    });
    assert.equal(me.status, 401);
  });

  it("revokes the session when called with a bearer token", async () => {
    const { email } = await registerUser();
    await login(email);
    const accessToken = api.jar.get("hos_access");
    assert.ok(accessToken);

    const response = await api.post(`${API}/logout`, { bearer: accessToken });
    assert.equal(response.status, 204);

    const me = await api.get(`${API}/me`, { bearer: accessToken });
    assert.equal(me.status, 401);
  });

  it("logout-all revokes every session of the account", async () => {
    const { email } = await registerUser();

    await login(email);
    const firstAccess = api.jar.get("hos_access");
    assert.ok(firstAccess);

    await login(email);
    const secondAccess = api.jar.get("hos_access");
    assert.ok(secondAccess);

    const response = await api.post(`${API}/logout-all`);
    assert.equal(response.status, 204);

    const firstMe = await api.get(`${API}/me`, { cookie: `hos_access=${firstAccess}` });
    const secondMe = await api.get(`${API}/me`, { cookie: `hos_access=${secondAccess}` });

    assert.equal(firstMe.status, 401);
    assert.equal(secondMe.status, 401);
  });
});

describe("POST /auth/change-password", () => {
  it("rejects an incorrect current password", async () => {
    const { email } = await registerUser();
    await login(email);

    const response = await api.post(`${API}/change-password`, {
      body: { currentPassword: "Wrong-Current-Password-2", newPassword: NEW_PASSWORD },
    });

    assert.equal(response.status, 400);
    assert.equal(errorCode(response), "BAD_REQUEST");
  });

  it("changes the password and revokes all sessions", async () => {
    const { email } = await registerUser();
    await login(email);
    const oldAccess = api.jar.get("hos_access");
    assert.ok(oldAccess);

    const response = await api.post(`${API}/change-password`, {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });

    assert.equal(response.status, 200);
    assert.equal(api.jar.get("hos_access"), undefined);

    const oldPasswordLogin = await login(email, PASSWORD);
    assert.equal(oldPasswordLogin.status, 401);

    const oldSession = await api.get(`${API}/me`, { cookie: `hos_access=${oldAccess}` });
    assert.equal(oldSession.status, 401);

    const newPasswordLogin = await login(email, NEW_PASSWORD);
    assert.equal(newPasswordLogin.status, 200);
  });

  it("requires CSRF protection", async () => {
    const { email } = await registerUser();
    await login(email);

    const response = await api.post(`${API}/change-password`, {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      csrf: false,
    });

    assert.equal(response.status, 403);
  });
});

describe("POST /auth/forgot-password and /auth/reset-password", () => {
  it("issues a reset token that changes the password once", async () => {
    const { email } = await registerUser();
    await login(email);
    const oldAccess = api.jar.get("hos_access");
    assert.ok(oldAccess);

    const forgot = await api.post(`${API}/forgot-password`, {
      body: { identifier: email },
    });

    assert.equal(forgot.status, 202);
    const reset = dataOf<{ resetToken?: string }>(forgot);
    assert.ok(reset.resetToken);

    const resetResponse = await api.post(`${API}/reset-password`, {
      body: { token: reset.resetToken, password: NEW_PASSWORD },
    });

    assert.equal(resetResponse.status, 200);

    const oldSession = await api.get(`${API}/me`, { cookie: `hos_access=${oldAccess}` });
    assert.equal(oldSession.status, 401);

    const oldPasswordLogin = await login(email, PASSWORD);
    assert.equal(oldPasswordLogin.status, 401);

    const newPasswordLogin = await login(email, NEW_PASSWORD);
    assert.equal(newPasswordLogin.status, 200);

    const reuse = await api.post(`${API}/reset-password`, {
      body: { token: reset.resetToken, password: "Another-Valid-Password-4" },
    });
    assert.equal(reuse.status, 400);
  });

  it("returns the same response for unknown accounts", async () => {
    const response = await api.post(`${API}/forgot-password`, {
      body: { identifier: uniqueEmail() },
    });

    assert.equal(response.status, 202);
    const body = dataOf<{ message: string; resetToken?: string }>(response);
    assert.equal(body.resetToken, undefined);
    assert.ok(body.message.length > 0);
  });

  it("rejects an invalid reset token", async () => {
    const response = await api.post(`${API}/reset-password`, {
      body: { token: "x".repeat(40), password: NEW_PASSWORD },
    });

    assert.equal(response.status, 400);
  });

  it("supports requesting a reset by phone number", async () => {
    const phone = uniquePhone();
    await registerUser({ phone });

    const response = await api.post(`${API}/forgot-password`, {
      body: { identifier: phone },
    });

    assert.equal(response.status, 202);
    assert.ok(dataOf<{ resetToken?: string }>(response).resetToken);
  });
});

describe("GET /auth/sessions", () => {
  it("lists active sessions and marks the current one", async () => {
    const { email } = await registerUser();

    await login(email);
    const firstAccess = api.jar.get("hos_access");
    assert.ok(firstAccess);

    await login(email);
    const response = await api.get(`${API}/sessions`);

    assert.equal(response.status, 200);
    const { sessions } = dataOf<{
      sessions: Array<{ id: string; isCurrent: boolean }>;
    }>(response);

    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((session) => session.isCurrent).length, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /token_hash|tokenHash/);

    const firstSessionList = await api.get(`${API}/sessions`, {
      cookie: `hos_access=${firstAccess}`,
    });
    assert.equal(firstSessionList.status, 200);
    assert.equal(
      dataOf<{ sessions: unknown[] }>(firstSessionList).sessions.length,
      2,
      "the first session is still active",
    );
  });
});

describe("login rate limiting", () => {
  it("rejects attempts beyond the per-account budget", async () => {
    const { email } = await registerUser();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(email, "Wrong-Password-Attempt-1");
      assert.equal(response.status, 401);
    }

    const blocked = await login(email, "Wrong-Password-Attempt-1");
    assert.equal(blocked.status, 429);
    assert.equal(errorCode(blocked), "RATE_LIMITED");

    const correctButBlocked = await login(email, PASSWORD);
    assert.equal(correctButBlocked.status, 429);
  });
});
