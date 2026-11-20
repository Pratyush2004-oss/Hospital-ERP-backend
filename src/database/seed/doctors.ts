import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  doctorBreaks,
  doctorBranches,
  doctorDepartments,
  doctorSchedules,
  doctors,
} from "../schema/index.js";
import { ensureMembership } from "./access.js";
import { branchKey, departmentKey, hashSeedPassword, upsertUser } from "./helpers.js";
import type { SeededDepartments } from "./departments.js";
import type { SeededTenancy } from "./tenancy.js";

interface ScheduleSeed {
  readonly branchCode: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  readonly days: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMinutes: number;
  readonly breaks?: readonly {
    readonly startTime: string;
    readonly endTime: string;
    readonly reason: string;
  }[];
}

interface DoctorSeed {
  readonly tenantSlug: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly registrationNumber: string;
  readonly qualification: string;
  readonly specialization: string;
  readonly experienceYears: number;
  readonly biography: string;
  readonly departments: readonly { readonly branchCode: string; readonly slug: string }[];
  readonly branches: readonly { readonly branchCode: string; readonly consultationFee: string }[];
  readonly schedules: readonly ScheduleSeed[];
}

/** Roster effective from this date; every window below is currently active. */
const EFFECTIVE_FROM = "2026-01-01";

const DOCTOR_SEEDS: readonly DoctorSeed[] = [
  {
    tenantSlug: "st-marys-general",
    fullName: "Dr. Priya Raman",
    email: "priya.raman@stmarys.test",
    phone: "+1-555-0111",
    registrationNumber: "SMG-CARD-001",
    qualification: "MD, DM (Cardiology)",
    specialization: "Cardiology",
    experienceYears: 14,
    biography: "Interventional cardiologist with a focus on preventive heart care.",
    departments: [
      { branchCode: "SMG-CEN", slug: "cardiology" },
      { branchCode: "SMG-CEN", slug: "general-medicine" },
    ],
    branches: [
      { branchCode: "SMG-CEN", consultationFee: "150.00" },
      { branchCode: "SMG-RIV", consultationFee: "175.00" },
    ],
    schedules: [
      {
        branchCode: "SMG-CEN",
        days: [1, 3],
        startTime: "09:00:00",
        endTime: "13:00:00",
        slotDurationMinutes: 20,
        breaks: [{ startTime: "11:00:00", endTime: "11:15:00", reason: "Ward round" }],
      },
      {
        branchCode: "SMG-CEN",
        days: [2],
        startTime: "14:00:00",
        endTime: "18:00:00",
        slotDurationMinutes: 15,
      },
    ],
  },
  {
    tenantSlug: "st-marys-general",
    fullName: "Dr. Daniel Okafor",
    email: "daniel.okafor@stmarys.test",
    phone: "+1-555-0112",
    registrationNumber: "SMG-GEN-002",
    qualification: "MBBS, MD (Internal Medicine)",
    specialization: "Internal Medicine",
    experienceYears: 9,
    biography: "General physician covering adult and paediatric outpatient clinics.",
    departments: [
      { branchCode: "SMG-CEN", slug: "general-medicine" },
      { branchCode: "SMG-CEN", slug: "pediatrics" },
      { branchCode: "SMG-RIV", slug: "general-medicine" },
    ],
    branches: [
      { branchCode: "SMG-CEN", consultationFee: "90.00" },
      { branchCode: "SMG-RIV", consultationFee: "80.00" },
    ],
    schedules: [
      {
        branchCode: "SMG-CEN",
        days: [1, 2, 3, 4, 5],
        startTime: "08:30:00",
        endTime: "12:30:00",
        slotDurationMinutes: 15,
      },
      {
        branchCode: "SMG-RIV",
        days: [4],
        startTime: "15:00:00",
        endTime: "19:00:00",
        slotDurationMinutes: 20,
      },
    ],
  },
  {
    tenantSlug: "st-marys-general",
    fullName: "Dr. Sofia Alvarez",
    email: "sofia.alvarez@stmarys.test",
    phone: "+1-555-0113",
    registrationNumber: "SMG-RAD-003",
    qualification: "MD (Radiology)",
    specialization: "Diagnostic Radiology",
    experienceYears: 11,
    biography: "Radiologist reading CT, MRI and ultrasound studies.",
    departments: [
      { branchCode: "SMG-RIV", slug: "radiology" },
      { branchCode: "SMG-CEN", slug: "radiology" },
    ],
    branches: [
      { branchCode: "SMG-RIV", consultationFee: "120.00" },
      { branchCode: "SMG-CEN", consultationFee: "120.00" },
    ],
    schedules: [
      {
        branchCode: "SMG-RIV",
        days: [2, 4],
        startTime: "10:00:00",
        endTime: "16:00:00",
        slotDurationMinutes: 30,
        breaks: [{ startTime: "12:30:00", endTime: "13:00:00", reason: "Lunch" }],
      },
    ],
  },
  {
    tenantSlug: "northside-medical",
    fullName: "Dr. Marcus Lee",
    email: "marcus.lee@northside.test",
    phone: "+1-555-0211",
    registrationNumber: "NMC-CARD-001",
    qualification: "MD, FACC",
    specialization: "Interventional Cardiology",
    experienceYears: 17,
    biography: "Senior cardiologist leading the cath-lab programme.",
    departments: [{ branchCode: "NMC-MAIN", slug: "cardiology" }],
    branches: [{ branchCode: "NMC-MAIN", consultationFee: "200.00" }],
    schedules: [
      {
        branchCode: "NMC-MAIN",
        days: [1, 2, 4],
        startTime: "09:00:00",
        endTime: "17:00:00",
        slotDurationMinutes: 20,
        breaks: [{ startTime: "12:30:00", endTime: "13:00:00", reason: "Lunch" }],
      },
    ],
  },
  {
    tenantSlug: "northside-medical",
    fullName: "Dr. Hana Suzuki",
    email: "hana.suzuki@northside.test",
    phone: "+1-555-0212",
    registrationNumber: "NMC-PED-002",
    qualification: "MD (Pediatrics)",
    specialization: "Pediatrics",
    experienceYears: 8,
    biography: "Paediatrician with an interest in childhood asthma.",
    departments: [
      { branchCode: "NMC-MAIN", slug: "pediatrics" },
      { branchCode: "NMC-LKV", slug: "general-medicine" },
    ],
    branches: [
      { branchCode: "NMC-MAIN", consultationFee: "100.00" },
      { branchCode: "NMC-LKV", consultationFee: "95.00" },
    ],
    schedules: [
      {
        branchCode: "NMC-MAIN",
        days: [3],
        startTime: "09:00:00",
        endTime: "12:00:00",
        slotDurationMinutes: 15,
      },
      {
        branchCode: "NMC-LKV",
        days: [5],
        startTime: "13:00:00",
        endTime: "17:00:00",
        slotDurationMinutes: 20,
      },
    ],
  },
];

export async function seedDoctors(
  db: Database,
  tenancy: SeededTenancy,
  departmentIds: SeededDepartments,
  password: string,
): Promise<void> {
  const passwordHash = await hashSeedPassword(password);

  for (const seed of DOCTOR_SEEDS) {
    const tenantId = tenancy.tenantIds.get(seed.tenantSlug);

    if (!tenantId) {
      throw new Error(`Missing tenant for doctor seed ${seed.tenantSlug}`);
    }

    const userId = await upsertUser(db, {
      fullName: seed.fullName,
      email: seed.email,
      phone: seed.phone,
      passwordHash,
    });

    await ensureMembership(db, tenantId, userId, ["doctor"]);

    const [doctor] = await db
      .insert(doctors)
      .values({
        tenantId,
        userId,
        doctorCode: seed.registrationNumber,
        registrationNumber: seed.registrationNumber,
        qualification: seed.qualification,
        specialization: seed.specialization,
        experienceYears: seed.experienceYears,
        biography: seed.biography,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [doctors.tenantId, doctors.userId],
        set: {
          doctorCode: seed.registrationNumber,
          registrationNumber: seed.registrationNumber,
          qualification: seed.qualification,
          specialization: seed.specialization,
          experienceYears: seed.experienceYears,
          biography: seed.biography,
          isActive: true,
        },
      })
      .returning({ id: doctors.id });

    if (!doctor) {
      throw new Error(`Failed to seed doctor ${seed.registrationNumber}`);
    }

    for (const assignment of seed.branches) {
      const branchId = tenancy.branchIds.get(branchKey(seed.tenantSlug, assignment.branchCode));

      if (!branchId) {
        throw new Error(`Missing branch ${assignment.branchCode} for doctor ${seed.registrationNumber}`);
      }

      await db
        .insert(doctorBranches)
        .values({
          tenantId,
          doctorId: doctor.id,
          branchId,
          consultationFee: assignment.consultationFee,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [doctorBranches.tenantId, doctorBranches.doctorId, doctorBranches.branchId],
          set: { consultationFee: assignment.consultationFee, isActive: true },
        });
    }

    for (const link of seed.departments) {
      const departmentId = departmentIds.get(
        departmentKey(seed.tenantSlug, link.branchCode, link.slug),
      );

      if (!departmentId) {
        throw new Error(
          `Missing department ${link.branchCode}/${link.slug} for doctor ${seed.registrationNumber}`,
        );
      }

      await db
        .insert(doctorDepartments)
        .values({ tenantId, doctorId: doctor.id, departmentId })
        .onConflictDoNothing();
    }

    for (const schedule of seed.schedules) {
      const branchId = tenancy.branchIds.get(branchKey(seed.tenantSlug, schedule.branchCode));

      if (!branchId) {
        throw new Error(`Missing branch ${schedule.branchCode} for schedule`);
      }

      for (const dayOfWeek of schedule.days) {
        // No natural unique key exists on schedules, so dedupe on the full
        // window definition before inserting.
        const [existing] = await db
          .select({ id: doctorSchedules.id })
          .from(doctorSchedules)
          .where(
            and(
              eq(doctorSchedules.tenantId, tenantId),
              eq(doctorSchedules.doctorId, doctor.id),
              eq(doctorSchedules.branchId, branchId),
              eq(doctorSchedules.dayOfWeek, dayOfWeek),
              eq(doctorSchedules.startTime, schedule.startTime),
              eq(doctorSchedules.endTime, schedule.endTime),
              eq(doctorSchedules.effectiveFrom, EFFECTIVE_FROM),
            ),
          )
          .limit(1);

        let scheduleId = existing?.id;

        if (scheduleId) {
          await db
            .update(doctorSchedules)
            .set({ slotDurationMinutes: schedule.slotDurationMinutes, isActive: true })
            .where(eq(doctorSchedules.id, scheduleId));
        } else {
          const [created] = await db
            .insert(doctorSchedules)
            .values({
              tenantId,
              doctorId: doctor.id,
              branchId,
              dayOfWeek,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              slotDurationMinutes: schedule.slotDurationMinutes,
              effectiveFrom: EFFECTIVE_FROM,
              isActive: true,
            })
            .returning({ id: doctorSchedules.id });

          if (!created) {
            throw new Error(`Failed to seed schedule for doctor ${seed.registrationNumber}`);
          }

          scheduleId = created.id;
        }

        for (const pause of schedule.breaks ?? []) {
          const [existingBreak] = await db
            .select({ id: doctorBreaks.id })
            .from(doctorBreaks)
            .where(
              and(
                eq(doctorBreaks.tenantId, tenantId),
                eq(doctorBreaks.scheduleId, scheduleId),
                eq(doctorBreaks.startTime, pause.startTime),
                eq(doctorBreaks.endTime, pause.endTime),
              ),
            )
            .limit(1);

          if (!existingBreak) {
            await db.insert(doctorBreaks).values({
              tenantId,
              scheduleId,
              startTime: pause.startTime,
              endTime: pause.endTime,
              reason: pause.reason,
            });
          }
        }
      }
    }
  }
}
