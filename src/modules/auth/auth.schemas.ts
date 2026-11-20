import { z } from "zod";
import { passwordSchema } from "./auth.password.js";

/**
 * Emails are stored and compared in lower case (see the `users_email_unique`
 * index on `lower(email)`), so normalization happens before validation output
 * is handed to the service.
 */
const emailSchema = z
  .string()
  .trim()
  .min(3, "Email is required")
  .max(320, "Email must be at most 320 characters")
  .toLowerCase()
  .pipe(z.email("Enter a valid email address"));

/** Optional phone number; an empty string is treated as "not provided". */
const optionalPhoneSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .min(6, "Phone must be at least 6 characters")
    .max(32, "Phone must be at most 32 characters")
    .regex(/^\+?[0-9][0-9\s().-]{5,30}$/, "Enter a valid phone number")
    .optional(),
);

/** Login and recovery accept either an email address or a phone number. */
const identifierSchema = z
  .string()
  .trim()
  .min(3, "Enter your email or phone number")
  .max(320, "Identifier is too long");

export const registerSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(200, "Full name must be at most 200 characters"),
  email: emailSchema,
  phone: optionalPhoneSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: identifierSchema,
  password: z.string().min(1, "Password is required").max(128, "Password is too long"),
});

export const forgotPasswordSchema = z.object({
  identifier: identifierSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20, "Reset token is invalid").max(200, "Reset token is invalid"),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
