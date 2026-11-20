import { z } from "zod";
import { localTimeSchema } from "./schedule.schemas.js";

/**
 * Request validation for the doctor break API (Task 16.5).
 *
 * Breaks are recurring wall-clock pauses inside one schedule window, so the
 * same branch-local time rules as schedules apply and no UTC conversion is
 * performed. Window containment, overlap and the active-schedule requirement
 * remain in the break service.
 */

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0", second = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute) + Number(second) / 60;
}

const reasonSchema = z
  .string()
  .trim()
  .max(255, "Break reason must be at most 255 characters")
  .nullable()
  .optional();

export const createDoctorBreakSchema = z
  .object({
    scheduleId: z.uuid("Schedule id must be a UUID"),
    startTime: localTimeSchema,
    endTime: localTimeSchema,
    reason: reasonSchema,
  })
  .refine(
    (value) => timeToMinutes(value.startTime) < timeToMinutes(value.endTime),
    {
      message: "Break end time must be later than its start time",
      path: ["endTime"],
    },
  );

export const updateDoctorBreakSchema = z
  .object({
    startTime: localTimeSchema.optional(),
    endTime: localTimeSchema.optional(),
    reason: reasonSchema,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  })
  .refine(
    (value) =>
      value.startTime === undefined ||
      value.endTime === undefined ||
      timeToMinutes(value.startTime) < timeToMinutes(value.endTime),
    {
      message: "Break end time must be later than its start time",
      path: ["endTime"],
    },
  );

export const doctorBreakIdParamsSchema = z.object({
  id: z.uuid("Break id must be a UUID"),
});

export const listDoctorBreaksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  scheduleId: z.uuid("Schedule id must be a UUID").optional(),
  doctorId: z.uuid("Doctor id must be a UUID").optional(),
  branchId: z.uuid("Branch id must be a UUID").optional(),
});

export type CreateDoctorBreakBody = z.infer<typeof createDoctorBreakSchema>;
export type UpdateDoctorBreakBody = z.infer<typeof updateDoctorBreakSchema>;
export type DoctorBreakIdParams = z.infer<typeof doctorBreakIdParamsSchema>;
export type ListDoctorBreaksQuery = z.infer<typeof listDoctorBreaksQuerySchema>;
