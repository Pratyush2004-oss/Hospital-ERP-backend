import type { Database } from "../client.js";
import { departmentBranches, departments } from "../schema/index.js";
import { branchKey, departmentKey } from "./helpers.js";
import type { SeededTenancy } from "./tenancy.js";

interface DepartmentSeed {
  readonly tenantSlug: string;
  readonly branchCode: string;
  readonly items: readonly {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
  }[];
}

const DEPARTMENT_SEEDS: readonly DepartmentSeed[] = [
  {
    tenantSlug: "st-marys-general",
    branchCode: "SMG-CEN",
    items: [
      { slug: "cardiology", name: "Cardiology", description: "Heart and vascular care" },
      {
        slug: "general-medicine",
        name: "General Medicine",
        description: "Primary care and internal medicine",
      },
      { slug: "pediatrics", name: "Pediatrics", description: "Care for infants and children" },
      { slug: "radiology", name: "Radiology", description: "Diagnostic imaging" },
    ],
  },
  {
    tenantSlug: "st-marys-general",
    branchCode: "SMG-RIV",
    items: [
      {
        slug: "general-medicine",
        name: "General Medicine",
        description: "Outpatient primary care",
      },
      { slug: "pediatrics", name: "Pediatrics", description: "Outpatient child health" },
      { slug: "radiology", name: "Radiology", description: "Outpatient imaging" },
    ],
  },
  {
    tenantSlug: "st-marys-general",
    branchCode: "SMG-WST",
    items: [{ slug: "general-medicine", name: "General Medicine", description: "Walk-in clinic" }],
  },
  {
    tenantSlug: "northside-medical",
    branchCode: "NMC-MAIN",
    items: [
      { slug: "cardiology", name: "Cardiology", description: "Cardiac diagnostics and care" },
      {
        slug: "general-medicine",
        name: "General Medicine",
        description: "Adult primary care",
      },
      { slug: "pediatrics", name: "Pediatrics", description: "Child and adolescent health" },
    ],
  },
  {
    tenantSlug: "northside-medical",
    branchCode: "NMC-LKV",
    items: [
      {
        slug: "general-medicine",
        name: "General Medicine",
        description: "Community primary care",
      },
      { slug: "radiology", name: "Radiology", description: "Imaging and scans" },
    ],
  },
];

/** `tenantSlug|branchCode|departmentSlug` -> department id */
export type SeededDepartments = Map<string, string>;

export async function seedDepartments(
  db: Database,
  tenancy: SeededTenancy,
): Promise<SeededDepartments> {
  const departmentIds: SeededDepartments = new Map();

  for (const seed of DEPARTMENT_SEEDS) {
    const tenantId = tenancy.tenantIds.get(seed.tenantSlug);
    const branchId = tenancy.branchIds.get(branchKey(seed.tenantSlug, seed.branchCode));

    if (!tenantId || !branchId) {
      throw new Error(`Missing tenant/branch for department seed ${seed.tenantSlug}/${seed.branchCode}`);
    }

    for (const item of seed.items) {
      const [row] = await db
        .insert(departments)
        .values({
          tenantId,
          branchId,
          slug: item.slug,
          name: item.name,
          description: item.description,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [departments.tenantId, departments.branchId, departments.slug],
          set: { name: item.name, description: item.description, isActive: true },
        })
        .returning({ id: departments.id });

      if (!row) {
        throw new Error(`Failed to seed department ${seed.tenantSlug}/${item.slug}`);
      }

      await db
        .insert(departmentBranches)
        .values({ tenantId, departmentId: row.id, branchId })
        .onConflictDoNothing();

      departmentIds.set(departmentKey(seed.tenantSlug, seed.branchCode, item.slug), row.id);
    }
  }

  return departmentIds;
}
