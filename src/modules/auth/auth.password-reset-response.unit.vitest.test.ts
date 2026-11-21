import { describe, expect, it } from "vitest";
import {
  PASSWORD_RESET_GENERIC_MESSAGE,
  buildPasswordResetRequestResponse,
  type PasswordResetRequestResult,
} from "./auth.service.js";

const result: PasswordResetRequestResult = {
  resetToken: "raw-single-use-token",
  expiresAt: new Date("2026-01-01T00:15:00.000Z"),
  deliveryStatus: "SENT",
};

describe("forgot-password response shaping", () => {
  it("never includes token material in production", () => {
    const response = buildPasswordResetRequestResponse(result, {
      nodeEnv: "production",
      frontendUrl: "https://app.hospitalos.com",
    });

    expect(response).toEqual({ message: PASSWORD_RESET_GENERIC_MESSAGE });
    expect(JSON.stringify(response)).not.toContain(result.resetToken!);
  });

  it("adds an explicit reset link outside production", () => {
    const response = buildPasswordResetRequestResponse(result, {
      nodeEnv: "development",
      frontendUrl: "http://localhost:3000",
    });

    expect(response.resetToken).toBe(result.resetToken);
    expect(response.resetUrl).toBe(
      "http://localhost:3000/reset-password?token=raw-single-use-token",
    );
    expect(response.expiresAt).toBe("2026-01-01T00:15:00.000Z");
  });

  it("keeps the same generic body when no account matched", () => {
    const response = buildPasswordResetRequestResponse(
      { resetToken: null, expiresAt: null, deliveryStatus: null },
      { nodeEnv: "test", frontendUrl: "http://localhost:3000" },
    );

    expect(response).toEqual({ message: PASSWORD_RESET_GENERIC_MESSAGE });
  });
});
