import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../../test/database.js";
import {
  getBranchRevenueBreakdown,
  getDepartmentBillingSummary,
  getDoctorBillingSummary,
  getInvoiceStatusDistribution,
  getInvoiceTypeRevenueBreakdown,
  getOutstandingBalances,
  getPaymentAndRefundSummary,
  getPaymentMethodRevenueBreakdown,
  getPendingAndOverdueInvoices,
  getRefundStatusDistribution,
  getRevenueSummary,
  getRevenueTimeSeries,
} from "./billing-report.service.js";

/**
 * Phase 19.9.1 reporting service tests.
 *
 * Fixtures are inserted with the elevated test pool, then every assertion runs
 * through the service, which uses `getDb()` — the restricted `hospitalos_app`
 * role under RLS. That proves both the aggregate logic and that tenant
 * isolation holds without bypassing row-level security.
 *
 * Dates are chosen around the Asia/Kolkata midnight boundary:
 * - 2026-01-31T20:00Z is 2026-02-01 01:30 IST (February locally);
 * - the same instant is 2026-01-31 15:00 in America/New_York.
 */

const PASSWORD_HASH = "test-only-not-a-real-hash";

interface Fixture {
  tenantId: string;
  branchA: string;
  branchB: string;
  patient: string;
  userId: string;
  doctorA: string;
  doctorB: string;
  departmentCard: string;
  departmentLab: string;
  appointmentA: string;
  appointmentB: string;
  invoiceA1: string;
  invoiceA2: string;
  invoiceA3: string;
  invoiceA7: string;
  invoiceA8: string;
  invoiceB1: string;
  paymentP1: string;
  invoicePaymentP1: string;
}

let fixture: Fixture;
let otherTenantId: string;
let otherInvoiceId: string;
let userAId: string;
let userBId: string;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function text(value: string | number): string {
  return `${value}.00`;
}

async function insertFixture(): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  const tenantId = randomUUID();
  const otherTenant = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const otherBranch = randomUUID();
  const patient = randomUUID();
  const otherPatient = randomUUID();
  const userId = randomUUID();
  const doctorAUser = randomUUID();
  const doctorBUser = randomUUID();
  const otherUser = randomUUID();

  createdTenantIds.push(tenantId, otherTenant);
  createdUserIds.push(userId, doctorAUser, doctorBUser, otherUser);
  userAId = userId;
  userBId = otherUser;

  await pool.query(
    `insert into tenants (id, name, slug, timezone, status)
     values ($1, 'Reports A', $2, 'Asia/Kolkata', 'ACTIVE'),
            ($3, 'Reports B', $4, 'UTC', 'ACTIVE')`,
    [tenantId, `reports-a-${suffix}`, otherTenant, `reports-b-${suffix}`],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, 'Report Admin', $2, $5),
            ($3, 'Dr A', $4, $5),
            ($6, 'Dr B', $7, $5),
            ($8, 'Other Admin', $9, $5)`,
    [
      userId,
      `report-admin-${suffix}@reports.test`,
      doctorAUser,
      `dr-a-${suffix}@reports.test`,
      PASSWORD_HASH,
      doctorBUser,
      `dr-b-${suffix}@reports.test`,
      otherUser,
      `other-admin-${suffix}@reports.test`,
    ],
  );

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Riverside', $5, 'America/New_York'),
            ($6, $7, 'Other Branch', $8, 'UTC')`,
    [
      branchA,
      tenantId,
      `CEN-${suffix}`.toUpperCase(),
      branchB,
      `RIV-${suffix}`.toUpperCase(),
      otherBranch,
      otherTenant,
      `OTH-${suffix}`.toUpperCase(),
    ],
  );

  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, 'Report Patient'), ($4, $5, $6, 'Other Patient')`,
    [patient, tenantId, `MRN-${suffix}`, otherPatient, otherTenant, `MRN-O-${suffix}`],
  );

  const doctorA = randomUUID();
  const doctorB = randomUUID();
  const departmentCard = randomUUID();
  const departmentLab = randomUUID();
  const appointmentA = randomUUID();
  const appointmentB = randomUUID();

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $9)`,
    [
      doctorA,
      tenantId,
      doctorAUser,
      `DOC-A-${suffix}`,
      `REG-A-${suffix}`,
      doctorB,
      doctorBUser,
      `DOC-B-${suffix}`,
      `REG-B-${suffix}`,
    ],
  );
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, currency)
     values ($1, $2, $3, '100.00', 'USD'), ($1, $4, $5, '100.00', 'USD')`,
    [tenantId, doctorA, branchA, doctorB, branchB],
  );
  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug)
     values ($1, $2, $3, 'Cardiology', $4), ($5, $2, $6, 'Laboratory', $7)`,
    [
      departmentCard,
      tenantId,
      branchA,
      `cardiology-${suffix}`,
      departmentLab,
      branchB,
      `laboratory-${suffix}`,
    ],
  );
  await pool.query(
    `insert into appointments (
       id, tenant_id, patient_id, doctor_id, branch_id, department_id,
       appointment_code, appointment_source, appointment_type, appointment_status,
       start_at, end_at, consultation_fee, currency, created_by
     ) values
       ($1, $2, $3, $4, $5, $6, $7, 'RECEPTIONIST', 'CONSULTATION', 'CONFIRMED',
        '2026-01-15T09:00:00Z', '2026-01-15T09:30:00Z', '100.00', 'USD', $8),
       ($9, $2, $3, $10, $11, $12, $13, 'ONLINE', 'CONSULTATION', 'CONFIRMED',
        '2026-01-15T15:00:00Z', '2026-01-15T15:30:00Z', '100.00', 'USD', $8)`,
    [
      appointmentA,
      tenantId,
      patient,
      doctorA,
      branchA,
      departmentCard,
      `APPT-A-${suffix}`,
      userId,
      appointmentB,
      doctorB,
      branchB,
      departmentLab,
      `APPT-B-${suffix}`,
    ],
  );

  const invoiceA1 = randomUUID();
  const invoiceA2 = randomUUID();
  const invoiceA3 = randomUUID();
  const invoiceA4 = randomUUID();
  const invoiceA5 = randomUUID();
  const invoiceA6 = randomUUID();
  const invoiceA7 = randomUUID();
  const invoiceA8 = randomUUID();
  const invoiceOther = randomUUID();

  async function invoice(values: {
    id: string;
    tenant: string;
    branch: string;
    patientId: string;
    appointment: string | null;
    number: string;
    type: string;
    status: string;
    issueDate: string;
    dueDate?: string;
    currency?: string;
    total: string;
    paid: string;
    balance: string;
    createdBy: string;
  }): Promise<void> {
    await pool.query(
      `insert into invoices (
         id, tenant_id, branch_id, patient_id, appointment_id, invoice_number,
         invoice_type, invoice_status, issue_date, due_date, currency,
         subtotal, discount_total, tax_total, total_amount, amount_paid, balance_due, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'0.00','0.00',$12,$13,$14,$15)`,
      [
        values.id,
        values.tenant,
        values.branch,
        values.patientId,
        values.appointment,
        values.number,
        values.type,
        values.status,
        values.issueDate,
        values.dueDate ?? null,
        values.currency ?? "USD",
        values.total,
        values.paid,
        values.balance,
        values.createdBy,
      ],
    );
  }

  await invoice({
    id: invoiceA1,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: appointmentA,
    number: `A-${suffix}-1`,
    type: "CONSULTATION",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "1000.00",
    paid: "600.00",
    balance: "400.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA2,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-2`,
    type: "PHARMACY",
    status: "PARTIALLY_PAID",
    issueDate: "2026-01-20",
    total: "500.00",
    paid: "200.00",
    balance: "300.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA3,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-3`,
    type: "OTHER",
    status: "PAID",
    issueDate: "2025-12-31",
    total: "300.00",
    paid: "300.00",
    balance: "0.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA4,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-4`,
    type: "LABORATORY",
    status: "CANCELLED",
    issueDate: "2026-01-10",
    total: "200.00",
    paid: "0.00",
    balance: "200.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA5,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-5`,
    type: "OTHER",
    status: "DRAFT",
    issueDate: "2026-01-10",
    total: "400.00",
    paid: "0.00",
    balance: "400.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA6,
    tenant: tenantId,
    branch: branchB,
    patientId: patient,
    appointment: appointmentB,
    number: `B-${suffix}-1`,
    type: "CONSULTATION",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "700.00",
    paid: "400.00",
    balance: "300.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA7,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-6`,
    type: "OTHER",
    status: "OVERDUE",
    issueDate: "2026-01-02",
    dueDate: "2026-01-05",
    total: "250.00",
    paid: "100.00",
    balance: "150.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceA8,
    tenant: tenantId,
    branch: branchA,
    patientId: patient,
    appointment: null,
    number: `A-${suffix}-7`,
    type: "PROCEDURE",
    status: "ISSUED",
    issueDate: "2026-01-18",
    currency: "EUR",
    total: "100.00",
    paid: "0.00",
    balance: "100.00",
    createdBy: userId,
  });
  await invoice({
    id: invoiceOther,
    tenant: otherTenant,
    branch: otherBranch,
    patientId: otherPatient,
    appointment: null,
    number: `O-${suffix}-1`,
    type: "OTHER",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "9999.00",
    paid: "0.00",
    balance: "9999.00",
    createdBy: otherUser,
  });

  otherTenantId = otherTenant;
  otherInvoiceId = invoiceOther;

  const p1 = randomUUID();
  const p2 = randomUUID();
  const p4 = randomUUID();
  const p5 = randomUUID();
  const p6 = randomUUID();
  const pOther = randomUUID();
  const ipP1 = randomUUID();
  const ipP2 = randomUUID();
  const ipP5 = randomUUID();
  const ipP6 = randomUUID();

  await pool.query(
    `insert into payments (
       id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
       payment_status, received_by, received_at
     ) values
       ($1, $2, $3, $4, 'CASH', '600.00', 'USD', 'SUCCESSFUL', $5, '2026-01-15T20:00:00Z'),
       ($6, $2, $3, $4, 'CARD', '200.00', 'USD', 'SUCCESSFUL', $5, '2026-01-31T20:00:00Z'),
       ($7, $2, $3, $4, 'UPI', '50.00', 'USD', 'FAILED', $5, '2026-01-16T05:00:00Z'),
       ($8, $2, $3, $4, 'CASH', '100.00', 'USD', 'SUCCESSFUL', $5, '2026-01-18T05:00:00Z'),
       ($9, $2, $10, $4, 'CARD', '400.00', 'USD', 'SUCCESSFUL', $5, '2026-01-15T15:00:00Z'),
       ($11, $12, $13, $14, 'CASH', '5000.00', 'USD', 'SUCCESSFUL', $15, '2026-01-15T10:00:00Z')`,
    [
      p1,
      tenantId,
      branchA,
      patient,
      userId,
      p2,
      p4,
      p5,
      p6,
      branchB,
      pOther,
      otherTenant,
      otherBranch,
      otherPatient,
      otherUser,
    ],
  );

  await pool.query(
    `insert into invoice_payments (
       id, tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at
     ) values
       ($1, $2, $3, $4, '600.00', 'USD', 'SUCCESSFUL', '2026-01-15T20:00:00Z'),
       ($5, $2, $6, $7, '200.00', 'USD', 'SUCCESSFUL', '2026-01-31T20:00:00Z'),
       ($8, $2, $9, $10, '100.00', 'USD', 'SUCCESSFUL', '2026-01-18T05:00:00Z'),
       ($11, $2, $12, $13, '400.00', 'USD', 'SUCCESSFUL', '2026-01-15T15:00:00Z')`,
    [ipP1, tenantId, invoiceA1, p1, ipP2, invoiceA2, p2, ipP5, invoiceA7, p5, ipP6, invoiceA6, p6],
  );
  await pool.query(
    `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount)
     values ($1,$2,$3,'600.00'), ($1,$4,$5,'200.00'), ($1,$6,$7,'100.00'), ($1,$8,$9,'400.00')`,
    [tenantId, p1, invoiceA1, p2, invoiceA2, p5, invoiceA7, p6, invoiceA6],
  );
  await pool.query(
    `insert into invoice_refunds (
       tenant_id, invoice_id, payment_id, amount, currency, refund_status,
       refunded_at, created_at
     ) values
       ($1, $2, $3, '100.00', 'USD', 'SUCCESSFUL',
        '2026-01-25T10:00:00Z', '2026-01-24T10:00:00Z'),
       ($1, $2, $3, '50.00', 'USD', 'FAILED',
        '2026-01-26T10:00:00Z', '2026-01-24T10:00:00Z'),
       ($1, $2, $3, '25.00', 'USD', 'PENDING',
        null, '2026-01-24T10:00:00Z'),
       ($4, $5, null, '500.00', 'USD', 'SUCCESSFUL',
        '2026-01-20T10:00:00Z', '2026-01-19T10:00:00Z')`,
    [tenantId, invoiceA1, ipP1, otherTenant, invoiceOther],
  );

  return {
    tenantId,
    branchA,
    branchB,
    patient,
    userId,
    doctorA,
    doctorB,
    departmentCard,
    departmentLab,
    appointmentA,
    appointmentB,
    invoiceA1,
    invoiceA2,
    invoiceA3,
    invoiceA7,
    invoiceA8,
    invoiceB1: invoiceA6,
    paymentP1: p1,
    invoicePaymentP1: ipP1,
  };
}

beforeAll(async () => {
  fixture = await insertFixture();
}, 30_000);

afterAll(async () => {
  if (createdTenantIds.length > 0) {
    await getTestAdminPool().query("delete from tenants where id = any($1::uuid[])", [
      createdTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await getTestAdminPool().query("delete from users where id = any($1::uuid[])", [
      createdUserIds,
    ]);
  }
  await closeTestAdminPool();
  await closePool();
}, 30_000);

const JANUARY_KOLKATA = {
  fromDate: "2026-01-01",
  toDate: "2026-01-31",
  branchId: undefined,
};

function january(branch?: string) {
  return { ...JANUARY_KOLKATA, branchId: branch };
}

describe("revenue and collection summary", () => {
  it("separates invoiced, collected, refunded, net and outstanding by currency", async () => {
    const summary = await getRevenueSummary(fixture.tenantId, january(fixture.branchA));

    expect(summary.timezone).toBe("Asia/Kolkata");
    expect(summary.invoiceCount).toBe(4);
    expect(summary.invoiced).toEqual([
      { currency: "EUR", amount: "100.00" },
      { currency: "USD", amount: "1750.00" },
    ]);
    // P1 600 + P5 100; P2 is 2026-02-01 01:30 in Kolkata and P4 failed.
    expect(summary.collected).toEqual([{ currency: "USD", amount: "700.00" }]);
    expect(summary.refunded).toEqual([{ currency: "USD", amount: "100.00" }]);
    expect(summary.netCollected).toEqual([{ currency: "USD", amount: "600.00" }]);
    expect(summary.outstanding).toEqual([
      { currency: "EUR", amount: "100.00" },
      { currency: "USD", amount: "850.00" },
    ]);
  });

  it("excludes draft and cancelled invoices from invoiced totals and counts", async () => {
    const summary = await getRevenueSummary(fixture.tenantId, january(fixture.branchA));

    expect(summary.invoiced.find((row) => row.currency === "USD")?.amount).toBe("1750.00");
    expect(summary.invoiced.find((row) => row.currency === "USD")?.amount).not.toContain("2100");
  });

  it("moves the boundary instant between timezones consistently", async () => {
    const utc = await getRevenueSummary(fixture.tenantId, {
      ...january(fixture.branchA),
      timezone: "UTC",
    });
    // P2 (Jan 31 20:00Z) is inside January in UTC, unlike Kolkata.
    expect(utc.collected).toEqual([{ currency: "USD", amount: "900.00" }]);
    expect(utc.refunded).toEqual([{ currency: "USD", amount: "100.00" }]);

    const february = await getRevenueSummary(fixture.tenantId, {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
      branchId: fixture.branchA,
    });
    expect(february.collected).toEqual([{ currency: "USD", amount: "200.00" }]);
    expect(february.refunded).toEqual([]);
  });

  it("attributes collections through allocations when an invoice type is filtered", async () => {
    const consultation = await getRevenueSummary(fixture.tenantId, {
      ...january(fixture.branchA),
      invoiceType: "CONSULTATION",
    });
    expect(consultation.invoiceCount).toBe(1);
    expect(consultation.invoiced).toEqual([{ currency: "USD", amount: "1000.00" }]);
    expect(consultation.collected).toEqual([{ currency: "USD", amount: "600.00" }]);
    expect(consultation.refunded).toEqual([{ currency: "USD", amount: "100.00" }]);
    expect(consultation.outstanding).toEqual([{ currency: "USD", amount: "400.00" }]);
  });

  it("returns zero totals for a date range with no records", async () => {
    const empty = await getRevenueSummary(fixture.tenantId, {
      fromDate: "2030-01-01",
      toDate: "2030-01-31",
      branchId: fixture.branchA,
    });
    expect(empty.invoiceCount).toBe(0);
    expect(empty.invoiced).toEqual([]);
    expect(empty.collected).toEqual([]);
    expect(empty.refunded).toEqual([]);
    expect(empty.outstanding).toEqual([]);
    expect(empty.netCollected).toEqual([]);
  });
});

describe("outstanding, pending and overdue invoices", () => {
  it("sums open balances as of a local date without mixing currencies", async () => {
    const outstanding = await getOutstandingBalances(fixture.tenantId, {
      asOf: "2026-01-31",
      branchId: fixture.branchA,
    });

    expect(outstanding.asOf).toBe("2026-01-31");
    expect(outstanding.invoiceCount).toBe(4);
    expect(outstanding.outstanding).toEqual([
      { currency: "EUR", amount: "100.00" },
      { currency: "USD", amount: "850.00" },
    ]);
  });

  it("splits open balances into pending and overdue", async () => {
    const result = await getPendingAndOverdueInvoices(fixture.tenantId, january(fixture.branchA));

    expect(result.pending.invoiceCount).toBe(3);
    expect(result.pending.outstanding).toEqual([
      { currency: "EUR", amount: "100.00" },
      { currency: "USD", amount: "700.00" },
    ]);
    expect(result.overdue.invoiceCount).toBe(1);
    expect(result.overdue.outstanding).toEqual([{ currency: "USD", amount: "150.00" }]);
  });
});

describe("time series", () => {
  it("produces daily points with invoiced, collected, refunded and net amounts", async () => {
    const series = await getRevenueTimeSeries(fixture.tenantId, {
      ...january(fixture.branchA),
      granularity: "day",
    });

    expect(series.granularity).toBe("day");
    expect(series.timezone).toBe("Asia/Kolkata");

    const jan15 = series.points.find((point) => point.period === "2026-01-15");
    expect(jan15).toEqual({
      period: "2026-01-15",
      currency: "USD",
      invoiced: "1000.00",
      collected: "0.00",
      refunded: "0.00",
      netCollected: "0.00",
    });

    // 2026-01-15T20:00Z is 2026-01-16 01:30 in Kolkata.
    const jan16 = series.points.find((point) => point.period === "2026-01-16");
    expect(jan16).toEqual({
      period: "2026-01-16",
      currency: "USD",
      invoiced: "0.00",
      collected: "600.00",
      refunded: "0.00",
      netCollected: "600.00",
    });

    const jan25 = series.points.find((point) => point.period === "2026-01-25");
    expect(jan25?.refunded).toBe("100.00");
    expect(jan25?.netCollected).toBe("-100.00");
  });

  it("rolls daily data into weeks and months", async () => {
    const monthly = await getRevenueTimeSeries(fixture.tenantId, {
      ...january(fixture.branchA),
      granularity: "month",
    });
    expect(monthly.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          period: "2026-01-01",
          currency: "USD",
          invoiced: "1750.00",
          collected: "700.00",
          refunded: "100.00",
          netCollected: "600.00",
        }),
      ]),
    );

    const weekly = await getRevenueTimeSeries(fixture.tenantId, {
      ...january(fixture.branchA),
      granularity: "week",
    });
    const total = weekly.points
      .filter((point) => point.currency === "USD")
      .reduce((sum, point) => sum + Number(point.invoiced), 0);
    expect(total).toBe(1750);
  });
});

describe("distributions and breakdowns", () => {
  it("reports invoice status distribution including drafts and cancellations", async () => {
    const rows = await getInvoiceStatusDistribution(fixture.tenantId, january(fixture.branchA));
    const byStatus = new Map(rows.map((row) => [row.status, row]));

    expect(byStatus.get("ISSUED")?.count).toBe(2);
    expect(byStatus.get("PARTIALLY_PAID")?.count).toBe(1);
    expect(byStatus.get("OVERDUE")?.count).toBe(1);
    expect(byStatus.get("CANCELLED")?.count).toBe(1);
    expect(byStatus.get("DRAFT")?.count).toBe(1);
    expect(byStatus.get("PAID")).toBeUndefined();
  });

  it("excludes failed payments from collected revenue and reports them separately", async () => {
    const summary = await getPaymentAndRefundSummary(fixture.tenantId, january(fixture.branchA));
    const successful = summary.payments.find((row) => row.status === "SUCCESSFUL");
    const failed = summary.payments.find((row) => row.status === "FAILED");

    expect(successful?.totals).toEqual([{ currency: "USD", amount: "700.00" }]);
    expect(failed?.count).toBe(1);
    expect(failed?.totals).toEqual([{ currency: "USD", amount: "50.00" }]);

    const revenue = await getRevenueSummary(fixture.tenantId, january(fixture.branchA));
    expect(revenue.collected).toEqual([{ currency: "USD", amount: "700.00" }]);
  });

  it("includes only successful refunds and reports other refund states", async () => {
    const summary = await getPaymentAndRefundSummary(fixture.tenantId, january(fixture.branchA));
    const successful = summary.refunds.find((row) => row.status === "SUCCESSFUL");
    const failed = summary.refunds.find((row) => row.status === "FAILED");
    const pending = summary.refunds.find((row) => row.status === "PENDING");

    expect(successful?.count).toBe(1);
    expect(successful?.totals).toEqual([{ currency: "USD", amount: "100.00" }]);
    expect(failed?.totals).toEqual([{ currency: "USD", amount: "50.00" }]);
    expect(pending?.totals).toEqual([{ currency: "USD", amount: "25.00" }]);

    const refunds = await getRefundStatusDistribution(fixture.tenantId, january(fixture.branchA));
    expect(refunds.map((row) => row.status)).toEqual(["FAILED", "PENDING", "SUCCESSFUL"]);
  });

  it("breaks revenue down by branch and keeps branch timezones separate", async () => {
    const rows = await getBranchRevenueBreakdown(fixture.tenantId, january());
    const centralUsd = rows.find(
      (row) => row.branchId === fixture.branchA && row.currency === "USD",
    );
    const riversideUsd = rows.find(
      (row) => row.branchId === fixture.branchB && row.currency === "USD",
    );

    expect(centralUsd).toMatchObject({
      invoiceCount: 3,
      invoiced: "1750.00",
      collected: "700.00",
      refunded: "100.00",
      netCollected: "600.00",
      outstanding: "850.00",
    });
    expect(riversideUsd).toMatchObject({
      invoiceCount: 1,
      invoiced: "700.00",
      collected: "400.00",
      refunded: "0.00",
      outstanding: "300.00",
    });
  });

  it("breaks collections and refunds down by payment method", async () => {
    const rows = await getPaymentMethodRevenueBreakdown(
      fixture.tenantId,
      january(fixture.branchA),
    );
    const cash = rows.find((row) => row.paymentMethod === "CASH");

    expect(cash).toEqual({
      paymentMethod: "CASH",
      currency: "USD",
      paymentCount: 2,
      collected: "700.00",
      refunded: "100.00",
      netCollected: "600.00",
    });
  });

  it("breaks invoiced and collected revenue down by invoice type without double counting", async () => {
    const rows = await getInvoiceTypeRevenueBreakdown(fixture.tenantId, january(fixture.branchA));
    const byType = new Map(rows.map((row) => [row.invoiceType, row]));

    expect(byType.get("CONSULTATION")).toMatchObject({
      invoiceCount: 1,
      invoiced: "1000.00",
      collected: "600.00",
      refunded: "100.00",
      outstanding: "400.00",
    });
    expect(byType.get("PHARMACY")?.invoiced).toBe("500.00");
    expect(byType.get("OTHER")).toMatchObject({
      invoiced: "250.00",
      collected: "100.00",
      outstanding: "150.00",
    });
    expect(byType.has("LABORATORY")).toBe(false);

    const usdCollected = rows
      .filter((row) => row.currency === "USD")
      .reduce((sum, row) => sum + Number(row.collected), 0);
    expect(usdCollected).toBe(700);
  });
});

describe("doctor and department summaries", () => {
  it("attributes appointment invoices, collections and refunds to the doctor", async () => {
    const rows = await getDoctorBillingSummary(fixture.tenantId, january(fixture.branchA));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      doctorId: fixture.doctorA,
      doctorName: "Dr A",
      currency: "USD",
      invoiceCount: 1,
      invoiced: "1000.00",
      collected: "600.00",
      refunded: "100.00",
      netCollected: "500.00",
    });
  });

  it("supports doctor filters and returns empty for a doctor outside the branch", async () => {
    const rows = await getDoctorBillingSummary(fixture.tenantId, {
      ...january(fixture.branchA),
      doctorId: fixture.doctorB,
    });
    expect(rows).toEqual([]);

    const branchB = await getDoctorBillingSummary(fixture.tenantId, {
      ...january(fixture.branchB),
      doctorId: fixture.doctorB,
    });
    expect(branchB[0]).toMatchObject({
      doctorId: fixture.doctorB,
      invoiced: "700.00",
      collected: "400.00",
    });
  });

  it("attributes invoices to the appointment department exactly once", async () => {
    const rows = await getDepartmentBillingSummary(fixture.tenantId, january(fixture.branchA));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      departmentId: fixture.departmentCard,
      departmentName: "Cardiology",
      invoiceCount: 1,
      invoiced: "1000.00",
      collected: "600.00",
      refunded: "100.00",
    });

    const lab = await getDepartmentBillingSummary(fixture.tenantId, {
      ...january(fixture.branchA),
      departmentId: fixture.departmentLab,
    });
    expect(lab).toEqual([]);
  });
});

describe("tenant isolation and validation", () => {
  it("never includes another tenant's invoices, payments or refunds", async () => {
    const a = await getRevenueSummary(fixture.tenantId, january(fixture.branchA));
    const b = await getRevenueSummary(otherTenantId, {
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });

    expect(a.invoiced.find((row) => row.currency === "USD")?.amount).toBe("1750.00");
    expect(b.invoiced).toEqual([{ currency: "USD", amount: "9999.00" }]);
    expect(b.collected).toEqual([{ currency: "USD", amount: "5000.00" }]);
    expect(b.refunded).toEqual([{ currency: "USD", amount: "500.00" }]);
    expect(b.netCollected).toEqual([{ currency: "USD", amount: "4500.00" }]);
    expect(b.invoiceCount).toBe(1);

    const outstanding = await getOutstandingBalances(otherTenantId, { asOf: "2026-01-31" });
    expect(outstanding.outstanding).toEqual([{ currency: "USD", amount: "9999.00" }]);
    expect(outstanding.invoiceCount).toBe(1);
  });

  it("rejects invalid ranges, ids, filters and timezones", async () => {
    await expect(
      getRevenueSummary(fixture.tenantId, { fromDate: "2026-02-01", toDate: "2026-01-01" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      getRevenueSummary(fixture.tenantId, { fromDate: "2026-02-30", toDate: "2026-03-01" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      getRevenueSummary(fixture.tenantId, {
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        branchId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      getRevenueSummary(fixture.tenantId, {
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        timezone: "Mars/Olympus",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      getRevenueSummary(fixture.tenantId, {
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        invoiceType: "NOT_A_TYPE" as never,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("large result sets", () => {
  it("aggregates many invoices in the database", async () => {
    const count = 150;
    await getTestAdminPool().query(
      `insert into invoices (
         tenant_id, branch_id, patient_id, invoice_number, invoice_type, invoice_status,
         issue_date, currency, subtotal, discount_total, tax_total,
         total_amount, amount_paid, balance_due, created_by
       )
       select $1, $2, $3, 'M-' || $4 || '-' || n, 'OTHER', 'ISSUED',
              '2026-03-01', 'USD', '1.00', '0.00', '0.00', '1.00', '0.00', '1.00', $5
       from generate_series(1, $6) as n`,
      [
        fixture.tenantId,
        fixture.branchA,
        fixture.patient,
        randomUUID().slice(0, 8),
        userAId,
        count,
      ],
    );

    const summary = await getRevenueSummary(fixture.tenantId, {
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
      branchId: fixture.branchA,
    });

    expect(summary.invoiceCount).toBe(count);
    expect(summary.invoiced).toEqual([{ currency: "USD", amount: text(count) }]);
    expect(summary.outstanding).toEqual([{ currency: "USD", amount: text(count) }]);

    // Ignore userBId/otherInvoiceId here; they exist to make the isolation
    // fixture realistic and are asserted in that suite.
    expect(userBId).not.toBe("");
    expect(otherInvoiceId).not.toBe("");
  });
});
