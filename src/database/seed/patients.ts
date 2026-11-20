import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  patientAddresses,
  patientContacts,
  patientEmergencyContacts,
  patientProfiles,
} from "../schema/index.js";
import { hashSeedPassword, upsertUser } from "./helpers.js";
import type { SeededTenancy } from "./tenancy.js";

type PatientContactType = "MOBILE" | "HOME" | "WORK" | "GUARDIAN" | "OTHER";
type PatientGender = "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";
type PatientStatus = "ACTIVE" | "INACTIVE" | "DECEASED" | "ARCHIVED";
type BloodGroup =
  | "A_POSITIVE"
  | "A_NEGATIVE"
  | "B_POSITIVE"
  | "B_NEGATIVE"
  | "AB_POSITIVE"
  | "AB_NEGATIVE"
  | "O_POSITIVE"
  | "O_NEGATIVE";

interface ContactSeed {
  readonly contactType: PatientContactType;
  readonly phone?: string;
  readonly email?: string;
  readonly isPrimary?: boolean;
  readonly isVerified?: boolean;
}

interface AddressSeed {
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

interface EmergencyContactSeed {
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
}

interface PatientSeed {
  readonly tenantSlug: string;
  readonly patientCode: string;
  readonly fullName: string;
  readonly dateOfBirth: string;
  readonly gender: PatientGender;
  readonly bloodGroup: BloodGroup | null;
  readonly status: PatientStatus;
  /** Optional global account; most patients are registered without one. */
  readonly account?: { readonly email: string; readonly phone: string };
  readonly contacts: readonly ContactSeed[];
  readonly addresses: readonly AddressSeed[];
  readonly emergencyContacts: readonly EmergencyContactSeed[];
}

/**
 * Sample patients. Both hospitals deliberately issue the same local codes
 * (`P-000001`, ...), which must be legal because the MRN is unique only within
 * a tenant. Some patients have a global account, some have none.
 */
const PATIENT_SEEDS: readonly PatientSeed[] = [
  {
    tenantSlug: "st-marys-general",
    patientCode: "P-000001",
    fullName: "Eleanor Whitfield",
    dateOfBirth: "1958-04-12",
    gender: "FEMALE",
    bloodGroup: "O_POSITIVE",
    status: "ACTIVE",
    contacts: [
      {
        contactType: "MOBILE",
        phone: "+1-555-1101",
        email: "eleanor.whitfield@example.test",
        isPrimary: true,
        isVerified: true,
      },
      { contactType: "HOME", phone: "+1-555-1102", isPrimary: false, isVerified: false },
    ],
    addresses: [
      {
        addressLine1: "12 Maple Street",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Thomas Whitfield", relationship: "SPOUSE", phone: "+1-555-1102" }],
  },
  {
    tenantSlug: "st-marys-general",
    patientCode: "P-000002",
    fullName: "Rajesh Patel",
    dateOfBirth: "1979-09-03",
    gender: "MALE",
    bloodGroup: "B_POSITIVE",
    status: "ACTIVE",
    account: { email: "rajesh.patel@example.test", phone: "+1-555-1121" },
    contacts: [
      {
        contactType: "MOBILE",
        phone: "+1-555-1121",
        email: "rajesh.patel@example.test",
        isPrimary: true,
        isVerified: true,
      },
    ],
    addresses: [
      {
        addressLine1: "77 Orchard Lane",
        addressLine2: "Apt 3B",
        city: "Springfield",
        state: "IL",
        postalCode: "62703",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Nisha Patel", relationship: "SISTER", phone: "+1-555-1122" }],
  },
  {
    tenantSlug: "st-marys-general",
    patientCode: "P-000003",
    fullName: "Mia Chen",
    dateOfBirth: "2016-02-20",
    gender: "FEMALE",
    bloodGroup: "A_POSITIVE",
    status: "ACTIVE",
    contacts: [
      {
        contactType: "GUARDIAN",
        phone: "+1-555-1131",
        email: "grace.chen@example.test",
        isPrimary: true,
        isVerified: true,
      },
    ],
    addresses: [
      {
        addressLine1: "5 Birch Court",
        city: "Springfield",
        state: "IL",
        postalCode: "62702",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Grace Chen", relationship: "PARENT", phone: "+1-555-1131" }],
  },
  {
    tenantSlug: "northside-medical",
    patientCode: "P-000001",
    fullName: "George Holloway",
    dateOfBirth: "1946-11-30",
    gender: "MALE",
    bloodGroup: "AB_NEGATIVE",
    status: "ACTIVE",
    contacts: [
      { contactType: "HOME", phone: "+1-555-2101", isPrimary: true, isVerified: true },
    ],
    addresses: [
      {
        addressLine1: "2200 North Clark Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60614",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Martha Holloway", relationship: "SPOUSE", phone: "+1-555-2102" }],
  },
  {
    tenantSlug: "northside-medical",
    patientCode: "P-000002",
    fullName: "Amara Diallo",
    dateOfBirth: "1992-06-18",
    gender: "FEMALE",
    bloodGroup: "O_NEGATIVE",
    status: "ACTIVE",
    account: { email: "amara.diallo@example.test", phone: "+1-555-2121" },
    contacts: [
      {
        contactType: "MOBILE",
        phone: "+1-555-2121",
        email: "amara.diallo@example.test",
        isPrimary: true,
        isVerified: true,
      },
    ],
    addresses: [
      {
        addressLine1: "4100 North Broadway",
        city: "Chicago",
        state: "IL",
        postalCode: "60613",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Fatou Diallo", relationship: "MOTHER", phone: "+1-555-2122" }],
  },
  {
    tenantSlug: "northside-medical",
    patientCode: "P-000003",
    fullName: "Liam Novak",
    dateOfBirth: "2001-01-05",
    gender: "MALE",
    bloodGroup: "A_NEGATIVE",
    status: "INACTIVE",
    contacts: [
      { contactType: "MOBILE", phone: "+1-555-2131", isPrimary: true, isVerified: false },
    ],
    addresses: [
      {
        addressLine1: "19 West Erie Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60654",
        country: "US",
      },
    ],
    emergencyContacts: [{ name: "Petra Novak", relationship: "MOTHER", phone: "+1-555-2132" }],
  },
];

export async function seedPatients(
  db: Database,
  tenancy: SeededTenancy,
  password: string,
): Promise<void> {
  const passwordHash = await hashSeedPassword(password);

  for (const seed of PATIENT_SEEDS) {
    const tenantId = tenancy.tenantIds.get(seed.tenantSlug);

    if (!tenantId) {
      throw new Error(`Missing tenant for patient seed ${seed.tenantSlug}`);
    }

    let userId: string | null = null;

    if (seed.account) {
      userId = await upsertUser(db, {
        fullName: seed.fullName,
        email: seed.account.email,
        phone: seed.account.phone,
        passwordHash,
      });
    }

    const [patient] = await db
      .insert(patientProfiles)
      .values({
        tenantId,
        userId,
        patientCode: seed.patientCode,
        fullName: seed.fullName,
        dateOfBirth: seed.dateOfBirth,
        gender: seed.gender,
        bloodGroup: seed.bloodGroup,
        status: seed.status,
      })
      .onConflictDoUpdate({
        target: [patientProfiles.tenantId, patientProfiles.patientCode],
        set: {
          userId,
          fullName: seed.fullName,
          dateOfBirth: seed.dateOfBirth,
          gender: seed.gender,
          bloodGroup: seed.bloodGroup,
          status: seed.status,
        },
      })
      .returning({ id: patientProfiles.id });

    if (!patient) {
      throw new Error(`Failed to seed patient ${seed.tenantSlug}/${seed.patientCode}`);
    }

    for (const contact of seed.contacts) {
      const [existing] = await db
        .select({ id: patientContacts.id })
        .from(patientContacts)
        .where(
          and(
            eq(patientContacts.tenantId, tenantId),
            eq(patientContacts.patientId, patient.id),
            eq(patientContacts.contactType, contact.contactType),
            contact.phone ? eq(patientContacts.phone, contact.phone) : isNull(patientContacts.phone),
            contact.email ? eq(patientContacts.email, contact.email) : isNull(patientContacts.email),
          ),
        )
        .limit(1);

      if (existing) {
        await db
          .update(patientContacts)
          .set({ isPrimary: contact.isPrimary ?? false, isVerified: contact.isVerified ?? false })
          .where(eq(patientContacts.id, existing.id));
      } else {
        await db.insert(patientContacts).values({
          tenantId,
          patientId: patient.id,
          contactType: contact.contactType,
          phone: contact.phone ?? null,
          email: contact.email ?? null,
          isPrimary: contact.isPrimary ?? false,
          isVerified: contact.isVerified ?? false,
        });
      }
    }

    for (const address of seed.addresses) {
      const [existing] = await db
        .select({ id: patientAddresses.id })
        .from(patientAddresses)
        .where(
          and(
            eq(patientAddresses.tenantId, tenantId),
            eq(patientAddresses.patientId, patient.id),
            eq(patientAddresses.addressLine1, address.addressLine1),
            eq(patientAddresses.postalCode, address.postalCode),
          ),
        )
        .limit(1);

      const values = {
        tenantId,
        patientId: patient.id,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2 ?? null,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
      };

      if (existing) {
        await db.update(patientAddresses).set(values).where(eq(patientAddresses.id, existing.id));
      } else {
        await db.insert(patientAddresses).values(values);
      }
    }

    for (const emergency of seed.emergencyContacts) {
      const [existing] = await db
        .select({ id: patientEmergencyContacts.id })
        .from(patientEmergencyContacts)
        .where(
          and(
            eq(patientEmergencyContacts.tenantId, tenantId),
            eq(patientEmergencyContacts.patientId, patient.id),
            eq(patientEmergencyContacts.name, emergency.name),
            eq(patientEmergencyContacts.phone, emergency.phone),
          ),
        )
        .limit(1);

      if (!existing) {
        await db.insert(patientEmergencyContacts).values({
          tenantId,
          patientId: patient.id,
          name: emergency.name,
          relationship: emergency.relationship,
          phone: emergency.phone,
        });
      }
    }
  }
}
