import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { departmentBranches, departments } from "../../database/schema/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import {
  createDepartment,
  deleteDepartment,
  getDepartmentById,
  listDepartments,
  updateDepartment,
  updateDepartmentBranches,
  updateDepartmentStatus,
} from "./department.service.js";

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
}

const fixtures: Fixture[] = [];

async function createTenant(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const tenantId = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  const branchA = randomUUID();
  const branchB = randomUUID();

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code)
     values ($1, $2, 'Central', $3), ($4, $2, 'Riverside', $5)`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  const fixture = { tenantId, branchA, branchB };
  fixtures.push(fixture);
  return fixture;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

let primary: Fixture;
let other: Fixture;

beforeAll(async () => {
  primary = await createTenant("alpha");
  other = await createTenant("beta");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("department service", () => {
  it("creates a department on the tenant's first branch when none are supplied", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: "Cardiology",
      slug: uniqueSlug("cardiology"),
      description: "Heart care",
    });

    expect(created.id).toBeTruthy();
    expect(created.isActive).toBe(true);
    // Without an explicit list the first live branch of the tenant is used.
    expect([primary.branchA, primary.branchB]).toContain(created.branchId);
    expect(created.branches).toHaveLength(1);
    expect(created.branches[0]?.id).toBe(created.branchId);
  });

  it("rejects a duplicate slug anywhere in the tenant", async () => {
    const slug = uniqueSlug("neurology");

    await createDepartment(primary.tenantId, {
      name: "Neurology",
      slug,
      branchIds: [primary.branchA],
    });

    await expect(
      createDepartment(primary.tenantId, {
        name: "Neurology Riverside",
        slug,
        branchIds: [primary.branchB],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The same slug is free in another tenant.
    await expect(
      createDepartment(other.tenantId, { name: "Neurology", slug }),
    ).resolves.toMatchObject({ slug });
  });

  it("creates a department operating in multiple branches", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: `Orthopedics ${randomUUID().slice(0, 5)}`,
      branchIds: [primary.branchA, primary.branchB, primary.branchA],
    });

    expect(created.branches).toHaveLength(2);
    expect(new Set(created.branches.map((branch) => branch.id))).toEqual(
      new Set([primary.branchA, primary.branchB]),
    );
    expect(created.branchId).toBe(primary.branchA);
  });

  it("rejects a branch owned by another tenant", async () => {
    await expect(
      createDepartment(primary.tenantId, {
        name: "Foreign Branch Department",
        branchIds: [other.branchA],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lists departments with pagination", async () => {
    const fixture = await createTenant("paging");
    const room = await createDepartment(fixture.tenantId, { name: "Room One" });
    expect(room.isActive).toBe(true);

    const first = await listDepartments(fixture.tenantId, { page: 1, pageSize: 1 });
    expect(first.total).toBe(1);
    expect(first.totalPages).toBe(1);

    await createDepartment(fixture.tenantId, { name: "Second Unit" });
    await createDepartment(fixture.tenantId, { name: "Third Unit" });

    const pageOne = await listDepartments(fixture.tenantId, { page: 1, pageSize: 2 });
    expect(pageOne.total).toBe(3);
    expect(pageOne.totalPages).toBe(2);
    expect(pageOne.departments).toHaveLength(2);

    const pageTwo = await listDepartments(fixture.tenantId, { page: 2, pageSize: 2 });
    expect(pageTwo.departments).toHaveLength(1);
  });

  it("searches and filters by status and branch", async () => {
    const fixture = await createTenant("filter");
    const searchable = await createDepartment(fixture.tenantId, {
      name: "Radiology Imaging",
      branchIds: [fixture.branchA],
    });
    const inactive = await createDepartment(fixture.tenantId, {
      name: "Radiology Archive",
      branchIds: [fixture.branchB],
      isActive: false,
    });

    const bySearch = await listDepartments(fixture.tenantId, { search: "imaging" });
    expect(bySearch.departments.map((d) => d.id)).toEqual([searchable.id]);

    const byStatus = await listDepartments(fixture.tenantId, { isActive: false });
    expect(byStatus.departments.map((d) => d.id)).toEqual([inactive.id]);

    const byBranch = await listDepartments(fixture.tenantId, { branchId: fixture.branchB });
    expect(byBranch.departments.map((d) => d.id)).toEqual([inactive.id]);

    const sorted = await listDepartments(fixture.tenantId, {
      sortBy: "name",
      sortOrder: "desc",
    });
    expect(sorted.departments[0]?.id).toBe(searchable.id);
  });

  it("returns department details and a consistent not-found error", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: "Details Unit",
      branchIds: [primary.branchB],
    });

    const found = await getDepartmentById(primary.tenantId, created.id);
    expect(found.id).toBe(created.id);
    expect(found.branches[0]?.id).toBe(primary.branchB);

    await expect(
      getDepartmentById(primary.tenantId, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates fields, rejects duplicate slugs and prevents deleted updates", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: "Update Unit",
      slug: uniqueSlug("update-unit"),
    });
    const reserved = await createDepartment(primary.tenantId, {
      name: "Reserved Slug Unit",
      slug: uniqueSlug("reserved"),
    });

    const updated = await updateDepartment(primary.tenantId, created.id, {
      name: "Updated Unit",
      description: "Renamed",
    });
    expect(updated.name).toBe("Updated Unit");
    expect(updated.description).toBe("Renamed");

    await expect(
      updateDepartment(primary.tenantId, created.id, { slug: reserved.slug }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await deleteDepartment(primary.tenantId, created.id);

    await expect(
      updateDepartment(primary.tenantId, created.id, { name: "Ghost" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("replaces branch associations explicitly", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: "Branch Swap",
      branchIds: [primary.branchA],
    });

    const replaced = await updateDepartmentBranches(primary.tenantId, created.id, [
      primary.branchB,
    ]);
    expect(replaced.branches.map((branch) => branch.id)).toEqual([primary.branchB]);
    expect(replaced.branchId).toBe(primary.branchB);

    const cleared = await updateDepartmentBranches(primary.tenantId, created.id, []);
    expect(cleared.branches).toHaveLength(0);
  });

  it("changes department status", async () => {
    const created = await createDepartment(primary.tenantId, { name: "Status Unit" });

    const deactivated = await updateDepartmentStatus(primary.tenantId, created.id, false);
    expect(deactivated.isActive).toBe(false);

    const reactivated = await updateDepartmentStatus(primary.tenantId, created.id, true);
    expect(reactivated.isActive).toBe(true);
  });

  it("soft deletes idempotently and hides the department from reads", async () => {
    const fixture = await createTenant("delete");
    const created = await createDepartment(fixture.tenantId, { name: "Delete Unit" });

    await deleteDepartment(fixture.tenantId, created.id);
    await expect(deleteDepartment(fixture.tenantId, created.id)).resolves.toBeUndefined();

    await expect(
      getDepartmentById(fixture.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const listed = await listDepartments(fixture.tenantId, {});
    expect(listed.departments).toHaveLength(0);
  });

  it("keeps departments isolated between tenants, including RLS on associations", async () => {
    const created = await createDepartment(primary.tenantId, {
      name: "Isolated Unit",
      branchIds: [primary.branchA, primary.branchB],
    });

    await expect(
      getDepartmentById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDepartment(other.tenantId, created.id, { name: "Hijacked" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deleteDepartment(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    // RLS (restricted app role) hides the rows in another tenant's transaction,
    // and tenant context does not leak across pooled transactions.
    const visibleToOther = await withTenantTransaction(other.tenantId, (tx) =>
      tx.select({ id: departments.id }).from(departments),
    );
    expect(visibleToOther.some((row) => row.id === created.id)).toBe(false);

    const associationsVisibleToOther = await withTenantTransaction(other.tenantId, (tx) =>
      tx.select({ id: departmentBranches.id }).from(departmentBranches),
    );
    const ownAssociations = await withTenantTransaction(primary.tenantId, (tx) =>
      tx
        .select({ id: departmentBranches.id })
        .from(departmentBranches)
        .where(eq(departmentBranches.departmentId, created.id)),
    );

    const otherIds = new Set(associationsVisibleToOther.map((row) => row.id));
    expect(ownAssociations.some((row) => otherIds.has(row.id))).toBe(false);

    const backToPrimary = await withTenantTransaction(primary.tenantId, (tx) =>
      tx.select({ id: departments.id }).from(departments),
    );
    expect(backToPrimary.some((row) => row.id === created.id)).toBe(true);
  });
});
