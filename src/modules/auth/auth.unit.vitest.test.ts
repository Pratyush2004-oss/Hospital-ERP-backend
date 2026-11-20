import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth.password.js";
import {
  generateCsrfToken,
  generateRefreshToken,
  hashToken,
  safeTokenEquals,
  signAccessToken,
  verifyAccessToken,
} from "./auth.tokens.js";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");

    expect(hash.startsWith("$2")).toBe(true);
    await expect(verifyPassword("Correct-Horse-Battery-9", hash)).resolves.toBe(true);
    await expect(verifyPassword("Wrong-Horse-Battery-9", hash)).resolves.toBe(false);
  });

  it("uses a fresh salt for every hash", async () => {
    const first = await hashPassword("Correct-Horse-Battery-9");
    const second = await hashPassword("Correct-Horse-Battery-9");

    expect(first).not.toBe(second);
    await expect(verifyPassword("Correct-Horse-Battery-9", first)).resolves.toBe(true);
    await expect(verifyPassword("Correct-Horse-Battery-9", second)).resolves.toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-a-bcrypt-hash")).resolves.toBe(false);
  });
});

describe("access tokens", () => {
  it("round-trips identity and session claims", async () => {
    const token = await signAccessToken({ userId: "user-1", sessionId: "session-1" });

    await expect(verifyAccessToken(token)).resolves.toEqual({
      userId: "user-1",
      sessionId: "session-1",
    });
  });

  it("rejects tampered and malformed tokens", async () => {
    const token = await signAccessToken({ userId: "user-1", sessionId: "session-1" });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifyAccessToken(tampered)).resolves.toBeNull();
    await expect(verifyAccessToken("not-a-jwt")).resolves.toBeNull();
  });
});

describe("opaque token helpers", () => {
  it("generates a refresh token and stores only its hash", () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThan(40);
    expect(first.tokenHash).toBe(hashToken(first.token));
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).not.toBe(first.token);
  });

  it("compares CSRF tokens timing-safely", () => {
    const token = generateCsrfToken();

    expect(safeTokenEquals(token, token)).toBe(true);
    expect(safeTokenEquals(token, `${token}x`)).toBe(false);
    expect(safeTokenEquals(token, generateCsrfToken())).toBe(false);
  });
});
