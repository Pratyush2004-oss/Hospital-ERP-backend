import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import {
  createInvoice,
  getInvoiceById,
  getInvoiceByNumber,
  listInvoices,
} from "./invoice.service.js";
import type { CreateInvoiceInput } from "./invoice.types.js";

/**
 * Service-level tests for Task 19.2.2.
 *
 * Fixtures are created with the admin connection; the service itself runs in a
 * tenant-scoped transaction as the restricted `hospitalos_app` role, so RLS is
 * exercised on every query.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly userId: string;
  readonly patientId: string;
  readonly secondPatientId: string;
  readonly doctorId: string;
  readonly appointmentId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const userId = randomUUID();
  const patientId = randomUUID();
  const secondPatientId = randomUUID();
  const doctorId = randomUUID();
  const appointmentId = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'UTC'), ($4, $2, 'Riverside', $5, 'UTC')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'invoice-service-test-hash')`,
    [userId, "Billing Clerk", `billing-${suffix}@invoices.test`],
  );
  createdUserIds.push(userId);

  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, 'Ada Patient'), ($4, $2, $5, 'Ben Patient')`,
    [patientId, tenantId, `P-${suffix}`, secondPatientId, `P2-${suffix}`],
  );

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5)`,
    [doctorId, tenantId, userId, `DOC-${suffix}`, `REG-${suffix}`],
  );

  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id) values ($1, $2, $3)`,
    [tenantId, doctorId, branchA],
  );

  await pool.query(
    `insert into appointments (
       id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
       appointment_source, start_at, end_at, created_by
     ) values ($1, $2, $3, $4, $5, $6, 'RECEPTIONIST', now(), now() + interval '30 minutes', $7)`,
    [appointmentId, tenantId, patientId, doctorId, branchA, `APT-${suffix}`, userId],
  );

  const fixture = {
    tenantId,
    branchA,
    branchB,
    userId,
    patientId,
    secondPatientId,
    doctorId,
    appointmentId,
  };

  fixtures.push(fixture);
  return fixture;
}

function newInvoice(
  fixture: Fixture,
  overrides: Partial<CreateInvoiceInput> = {},
): CreateInvoiceInput {
  return {
    branchId: fixture.branchA,
    patientId: fixture.patientId,
    createdBy: fixture.userId,
    items: [{ itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice: "150.00" }],
    ...overrides,
  };
}

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("invoice creation", () => {
  it("creates a DRAFT invoice with multiple items and server-calculated totals", async () => {
    const fixture = await createFixture("create");

    const created = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        invoiceType: "CONSULTATION",
        currency: "usd",
        notes: "  Billing remark  ",
        items: [
          { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice: "150.00", taxRate: "10" },
          {
            itemType: "PROCEDURE",
            description: "Dressing",
            quantity: 3,
            unitPrice: "19.99",
            discountType: "PERCENTAGE",
            discountValue: "10",
            taxRate: "5",
          },
        ],
      }),
    );

    expect(created).toMatchObject({
      invoiceNumber: "INV-000001",
      invoiceStatus: "DRAFT",
      invoiceType: "CONSULTATION",
      branchId: fixture.branchA,
      patientId: fixture.patientId,
      appointmentId: null,
      issueDate: todayUtc(),
      dueDate: null,
      currency: "USD",
      notes: "Billing remark",
      subtotal: "209.97",
      discountTotal: "6.00",
      taxTotal: "17.70",
      totalAmount: "221.67",
      amountPaid: "0.00",
      balanceDue: "221.67",
      createdBy: fixture.userId,
    });

    expect(created.items).toHaveLength(2);
    expect(created.items[0]).toMatchObject({
      itemType: "CONSULTATION",
      quantity: "1.000",
      unitPrice: "150.00",
      grossAmount: "150.00",
      discountAmount: "0.00",
      taxRate: "10.0000",
      taxAmount: "15.00",
      lineTotal: "165.00",
      sortOrder: 0,
    });
    expect(created.items[1]).toMatchObject({
      description: "Dressing",
      quantity: "3.000",
      discountType: "PERCENTAGE",
      grossAmount: "59.97",
      discountAmount: "6.00",
      taxRate: "5.0000",
      taxAmount: "2.70",
      lineTotal: "56.67",
      sortOrder: 1,
    });

    // The persisted header reconciles with the persisted lines.
    const subtotal = created.items.reduce((sum, item) => sum + Number(item.grossAmount), 0);
    const total = created.items.reduce((sum, item) => sum + Number(item.lineTotal), 0);
    expect(subtotal.toFixed(2)).toBe(created.subtotal);
    expect(total.toFixed(2)).toBe(created.totalAmount);
  });

  it("links a matching appointment and rejects mismatched ones", async () => {
    const fixture = await createFixture("appointment");

    const linked = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, { appointmentId: fixture.appointmentId }),
    );

    expect(linked.appointmentId).toBe(fixture.appointmentId);

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, {
          appointmentId: fixture.appointmentId,
          patientId: fixture.secondPatientId,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, {
          appointmentId: fixture.appointmentId,
          branchId: fixture.branchB,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { appointmentId: randomUUID() })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects cross-tenant patient, branch and appointment references", async () => {
    const fixture = await createFixture("tenant-a");
    const other = await createFixture("tenant-b");

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { patientId: other.patientId })),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { branchId: other.branchA })),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, { appointmentId: other.appointmentId }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Nothing from the failed attempts leaked into the tenant.
    const listed = await listInvoices(fixture.tenantId);
    expect(listed.total).toBe(0);
  });

  it("rejects invalid references, empty item lists and bad dates", async () => {
    const fixture = await createFixture("validation");

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { patientId: randomUUID() })),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { items: [] })),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, { issueDate: "2026-02-10", dueDate: "2026-02-01" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { issueDate: "2026-02-31" })),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { invoiceNumber: "not allowed!" })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("invoice numbering", () => {
  it("allocates sequential numbers per tenant and skips manually used values", async () => {
    const fixture = await createFixture("numbering");

    const first = await createInvoice(fixture.tenantId, newInvoice(fixture));
    const second = await createInvoice(fixture.tenantId, newInvoice(fixture));
    const manual = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, { invoiceNumber: "inv-000003" }),
    );
    const afterManual = await createInvoice(fixture.tenantId, newInvoice(fixture));

    expect(first.invoiceNumber).toBe("INV-000001");
    expect(second.invoiceNumber).toBe("INV-000002");
    expect(manual.invoiceNumber).toBe("INV-000003");
    expect(afterManual.invoiceNumber).toBe("INV-000004");
  });

  it("rejects duplicate invoice numbers without creating a second invoice", async () => {
    const fixture = await createFixture("duplicate");
    const pool = getTestAdminPool();

    await createInvoice(fixture.tenantId, newInvoice(fixture, { invoiceNumber: "INV-CUSTOM-1" }));

    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { invoiceNumber: "INV-CUSTOM-1" })),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    const rows = await pool.query<{ total: number }>(
      "select count(*)::int as total from invoices where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(rows.rows[0]?.total).toBe(1);

    const items = await pool.query<{ total: number }>(
      "select count(*)::int as total from invoice_items where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(items.rows[0]?.total).toBe(1);
  });

  it("keeps numbering independent between tenants", async () => {
    const a = await createFixture("numbers-a");
    const b = await createFixture("numbers-b");

    const invoiceA = await createInvoice(a.tenantId, newInvoice(a));
    const invoiceB = await createInvoice(b.tenantId, newInvoice(b));

    expect(invoiceA.invoiceNumber).toBe("INV-000001");
    expect(invoiceB.invoiceNumber).toBe("INV-000001");
  });
});

describe("decimal precision", () => {
  it("persists exact decimal strings without binary float drift", async () => {
    const fixture = await createFixture("precision");

    const created = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        items: [
          { description: "Tiny item", quantity: "0.1", unitPrice: "0.20" },
          { description: "Half-cent tax", quantity: 1, unitPrice: "0.05", taxRate: "10" },
          { description: "Fractional quantity", quantity: "1.5", unitPrice: "10.00" },
        ],
      }),
    );

    expect(created.items.map((item) => item.grossAmount)).toEqual(["0.02", "0.05", "15.00"]);
    expect(created.items.map((item) => item.taxAmount)).toEqual(["0.00", "0.01", "0.00"]);
    expect(created.subtotal).toBe("15.07");
    expect(created.totalAmount).toBe("15.08");
  });

  it("rejects excess precision, negative values and oversized discounts", async () => {
    const fixture = await createFixture("precision-invalid");

    const invalidLines = [
      { description: "Price", quantity: 1, unitPrice: "10.999" },
      { description: "Quantity", quantity: "1.0001", unitPrice: "10.00" },
      { description: "Tax", quantity: 1, unitPrice: "10.00", taxRate: "7.55555" },
      { description: "Negative", quantity: "-1", unitPrice: "10.00" },
      {
        description: "Discount",
        quantity: 1,
        unitPrice: "10.00",
        discountType: "AMOUNT" as const,
        discountValue: "10.01",
      },
    ];

    for (const line of invalidLines) {
      await expect(
        createInvoice(fixture.tenantId, newInvoice(fixture, { items: [line] })),
      ).rejects.toMatchObject({ statusCode: 422 });
    }

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, {
          items: [
            {
              description: "Percent",
              quantity: 1,
              unitPrice: "10.00",
              discountType: "PERCENTAGE",
              discountValue: "101",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("transaction rollback", () => {
  it("rolls back the invoice, items and number allocation when the insert fails", async () => {
    const fixture = await createFixture("rollback");
    const pool = getTestAdminPool();

    // A non-existent creator passes validation and fails on the invoice insert
    // foreign key, after the number counter has already been incremented.
    await expect(
      createInvoice(fixture.tenantId, newInvoice(fixture, { createdBy: randomUUID() })),
    ).rejects.toMatchObject({ statusCode: 400 });

    const invoices = await pool.query<{ total: number }>(
      "select count(*)::int as total from invoices where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(invoices.rows[0]?.total).toBe(0);

    const items = await pool.query<{ total: number }>(
      "select count(*)::int as total from invoice_items where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(items.rows[0]?.total).toBe(0);

    // The counter increment was rolled back too, so the next invoice reuses 1.
    const created = await createInvoice(fixture.tenantId, newInvoice(fixture));
    expect(created.invoiceNumber).toBe("INV-000001");
  });

  it("writes no header when a line item fails validation", async () => {
    const fixture = await createFixture("rollback-lines");
    const pool = getTestAdminPool();

    await expect(
      createInvoice(
        fixture.tenantId,
        newInvoice(fixture, {
          items: [
            { description: "Valid", quantity: 1, unitPrice: "10.00" },
            { description: "Invalid", quantity: 1, unitPrice: "10.00", discountType: "AMOUNT", discountValue: "99.00" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    const invoices = await pool.query<{ total: number }>(
      "select count(*)::int as total from invoices where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(invoices.rows[0]?.total).toBe(0);
  });
});

describe("invoice retrieval", () => {
  it("fetches by id and by number, scoped to the tenant", async () => {
    const fixture = await createFixture("retrieval");
    const other = await createFixture("retrieval-other");

    const created = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        invoiceNumber: "INV-RETRIEVE-1",
        items: [
          { description: "Consultation", quantity: 1, unitPrice: "80.00" },
          { description: "Lab", quantity: 2, unitPrice: "25.00" },
        ],
      }),
    );

    const byId = await getInvoiceById(fixture.tenantId, created.id);
    expect(byId).toEqual(created);

    const byNumber = await getInvoiceByNumber(fixture.tenantId, "inv-retrieve-1");
    expect(byNumber).toEqual(created);

    await expect(getInvoiceById(fixture.tenantId, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });

    await expect(getInvoiceById(other.tenantId, created.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    await expect(
      getInvoiceByNumber(other.tenantId, created.invoiceNumber),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("invoice listing", () => {
  async function seedListing(fixture: Fixture): Promise<void> {
    await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        invoiceType: "CONSULTATION",
        issueDate: "2026-01-10",
        items: [{ description: "January visit", quantity: 1, unitPrice: "100.00" }],
      }),
    );

    await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        invoiceType: "LABORATORY",
        issueDate: "2026-02-15",
        items: [{ description: "Lab panel", quantity: 1, unitPrice: "60.00" }],
      }),
    );

    await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        branchId: fixture.branchB,
        patientId: fixture.secondPatientId,
        invoiceType: "PHARMACY",
        issueDate: "2026-03-01",
        items: [{ description: "Medication", quantity: 1, unitPrice: "30.00" }],
      }),
    );
  }

  it("paginates and filters by patient, branch, type and date range", async () => {
    const fixture = await createFixture("listing");
    const other = await createFixture("listing-other");
    await seedListing(fixture);

    const all = await listInvoices(fixture.tenantId, { pageSize: 2 });
    expect(all.total).toBe(3);
    expect(all.totalPages).toBe(2);
    expect(all.invoices).toHaveLength(2);
    // Newest issue date first.
    expect(all.invoices.map((invoice) => invoice.issueDate)).toEqual([
      "2026-03-01",
      "2026-02-15",
    ]);
    expect(all.invoices[0]).not.toHaveProperty("items");
    expect(all.invoices[0]).not.toHaveProperty("notes");

    const secondPage = await listInvoices(fixture.tenantId, { page: 2, pageSize: 2 });
    expect(secondPage.invoices.map((invoice) => invoice.issueDate)).toEqual(["2026-01-10"]);

    const byPatient = await listInvoices(fixture.tenantId, { patientId: fixture.patientId });
    expect(byPatient.total).toBe(2);

    const byBranch = await listInvoices(fixture.tenantId, { branchId: fixture.branchB });
    expect(byBranch.total).toBe(1);

    const byType = await listInvoices(fixture.tenantId, { invoiceType: "LABORATORY" });
    expect(byType.invoices.map((invoice) => invoice.invoiceType)).toEqual(["LABORATORY"]);

    const byStatus = await listInvoices(fixture.tenantId, { status: "DRAFT" });
    expect(byStatus.total).toBe(3);

    const byDate = await listInvoices(fixture.tenantId, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    expect(byDate.invoices.map((invoice) => invoice.issueDate)).toEqual(["2026-02-15"]);

    const none = await listInvoices(other.tenantId);
    expect(none.total).toBe(0);
  });

  it("rejects invalid filters and clamps pagination", async () => {
    const fixture = await createFixture("listing-validation");

    await expect(
      listInvoices(fixture.tenantId, { fromDate: "2026-03-01", toDate: "2026-02-01" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      listInvoices(fixture.tenantId, { status: "UNKNOWN" as never }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      listInvoices(fixture.tenantId, { fromDate: "2026-13-01" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const clamped = await listInvoices(fixture.tenantId, { page: 0, pageSize: 500 });
    expect(clamped.page).toBe(1);
    expect(clamped.pageSize).toBe(100);
  });
});
