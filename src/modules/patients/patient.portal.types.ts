import type { PublicUser } from "../auth/auth.service.js";
import type { PatientDetailDto, PatientStatus } from "./patient.types.js";

/** A hospital where the signed-in account has a linked patient profile. */
export interface PatientPortalHospitalSummary {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly patientId: string;
  readonly patientCode: string;
  readonly status: PatientStatus;
  readonly linkedAt: Date;
}

export interface PatientPortalRegistrationResult {
  readonly user: PublicUser;
  readonly patient: PatientDetailDto;
  /** True when a new global account was created and verification mail was sent. */
  readonly accountCreated: boolean;
  readonly requiresEmailVerification: boolean;
}
