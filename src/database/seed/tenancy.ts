import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { branches, tenants } from "../schema/index.js";
import { branchKey } from "./helpers.js";

/**
 * Two sample hospitals, each with its own branches. Seeded by natural keys
 * (`tenants.slug`, `(tenant_id, branch_code)`) so rerunning the seed updates the
 * same rows instead of creating duplicates.
 */
const TENANT_SEEDS = [
  {
    slug: "st-marys-general",
    name: "St. Mary's General Hospital",
    legalName: "St. Mary's General Hospital Ltd.",
    email: "contact@stmarys.test",
    phone: "+1-555-0100",
    timezone: "America/New_York",
    branches: [
      {
        branchCode: "SMG-CEN",
        name: "Central Campus",
        email: "central@stmarys.test",
        phone: "+1-555-0110",
        addressLine1: "400 Mercy Avenue",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
        country: "US",
        timezone: "America/New_York",
      },
      {
        branchCode: "SMG-RIV",
        name: "Riverside Clinic",
        email: "riverside@stmarys.test",
        phone: "+1-555-0120",
        addressLine1: "18 Riverbend Road",
        city: "Springfield",
        state: "IL",
        postalCode: "62702",
        country: "US",
        timezone: "America/New_York",
      },
      {
        branchCode: "SMG-WST",
        name: "Westside Annex",
        email: "westside@stmarys.test",
        phone: "+1-555-0130",
        addressLine1: "920 Prairie Lane",
        city: "Springfield",
        state: "IL",
        postalCode: "62704",
        country: "US",
        timezone: "America/New_York",
      },
    ],
  },
  {
    slug: "northside-medical",
    name: "Northside Medical Center",
    legalName: "Northside Medical Center LLC",
    email: "contact@northside.test",
    phone: "+1-555-0200",
    timezone: "America/Chicago",
    branches: [
      {
        branchCode: "NMC-MAIN",
        name: "Main Campus",
        email: "main@northside.test",
        phone: "+1-555-0210",
        addressLine1: "1200 Lakeshore Drive",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        timezone: "America/Chicago",
      },
      {
        branchCode: "NMC-LKV",
        name: "Lakeview Clinic",
        email: "lakeview@northside.test",
        phone: "+1-555-0220",
        addressLine1: "3550 North Halsted Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60613",
        country: "US",
        timezone: "America/Chicago",
      },
    ],
  },
] as const;

export interface SeededTenancy {
  /** tenant slug -> tenant id */
  tenantIds: Map<string, string>;
  /** `${tenantSlug}|${branchCode}` -> branch id */
  branchIds: Map<string, string>;
}

export async function seedTenancy(db: Database): Promise<SeededTenancy> {
  const tenantIds = new Map<string, string>();
  const branchIds = new Map<string, string>();

  for (const tenantSeed of TENANT_SEEDS) {
    const [tenant] = await db
      .insert(tenants)
      .values({
        slug: tenantSeed.slug,
        name: tenantSeed.name,
        legalName: tenantSeed.legalName,
        email: tenantSeed.email,
        phone: tenantSeed.phone,
        timezone: tenantSeed.timezone,
        status: "ACTIVE",
      })
      .onConflictDoUpdate({
        target: tenants.slug,
        set: {
          name: tenantSeed.name,
          legalName: tenantSeed.legalName,
          email: tenantSeed.email,
          phone: tenantSeed.phone,
          timezone: tenantSeed.timezone,
          status: "ACTIVE",
        },
      })
      .returning({ id: tenants.id });

    if (!tenant) {
      throw new Error(`Failed to seed tenant ${tenantSeed.slug}`);
    }

    tenantIds.set(tenantSeed.slug, tenant.id);

    for (const branchSeed of tenantSeed.branches) {
      const [existing] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, tenant.id),
            eq(branches.branchCode, branchSeed.branchCode),
          ),
        )
        .limit(1);

      const values = {
        tenantId: tenant.id,
        branchCode: branchSeed.branchCode,
        name: branchSeed.name,
        email: branchSeed.email,
        phone: branchSeed.phone,
        addressLine1: branchSeed.addressLine1,
        city: branchSeed.city,
        state: branchSeed.state,
        postalCode: branchSeed.postalCode,
        country: branchSeed.country,
        timezone: branchSeed.timezone,
        isActive: true,
      };

      let branchId = existing?.id;

      if (branchId) {
        await db.update(branches).set(values).where(eq(branches.id, branchId));
      } else {
        const [created] = await db
          .insert(branches)
          .values(values)
          .returning({ id: branches.id });

        if (!created) {
          throw new Error(`Failed to seed branch ${branchSeed.branchCode}`);
        }

        branchId = created.id;
      }

      branchIds.set(branchKey(tenantSeed.slug, branchSeed.branchCode), branchId);
    }
  }

  return { tenantIds, branchIds };
}
