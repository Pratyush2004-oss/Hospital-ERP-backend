import { z } from "zod";
import { passwordSchema } from "./auth.password.js";

/**
 * Emails are stored and compared in lower case (see the `users_email_unique`
 * index on `lower(email)`), so normalization happens before validation output
 * is handed to the service.
 */
export const emailSchema = z
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

/** Non-consuming reset-token inspection for the frontend reset page. */
export const resetPasswordTokenSchema = z.object({
  token: z.string().trim().min(20, "Reset token is invalid").max(200, "Reset token is invalid"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128),
  newPassword: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(20, "Verification link is invalid").max(200, "Verification link is invalid"),
});

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(20, "Invitation link is invalid").max(200, "Invitation link is invalid"),
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(200, "Full name must be at most 200 characters")
    .optional(),
  /** Required only when no account exists for the invited email yet. */
  password: passwordSchema.optional(),
});

export const staffInvitationSchema = z.object({
  email: emailSchema,
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(200, "Full name must be at most 200 characters")
    .optional(),
  roleIds: z.array(z.uuid("Role ids must be UUIDs")).max(10).default([]),
  departmentIds: z.array(z.uuid("Department ids must be UUIDs")).max(20).default([]),
  branchIds: z.array(z.uuid("Branch ids must be UUIDs")).max(20).default([]),
});

export const staffInvitationParamsSchema = z.object({
  invitationId: z.uuid("Invitation id must be a UUID"),
});

/** Invitation lookup uses a body token, never a URL path, to keep it out of logs. */
export const invitationDetailsSchema = z.object({
  token: z.string().trim().min(20, "Invitation link is invalid").max(200, "Invitation link is invalid"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResetPasswordTokenInput = z.infer<typeof resetPasswordTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type StaffInvitationSchemaInput = z.infer<typeof staffInvitationSchema>;
export type StaffInvitationParamsInput = z.infer<typeof staffInvitationParamsSchema>;
export type InvitationDetailsInput = z.infer<typeof invitationDetailsSchema>;
