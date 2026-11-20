import { describe, expect, it } from "vitest";
import { AppError } from "../../lib/http-error.js";
import {
  calculateBalanceDue,
  calculateInvoice,
  calculateInvoiceBalance,
  calculateInvoiceLine,
} from "./invoice-calculation.js";
import type {
  InvoiceCalculationInput,
  InvoicePaymentInput,
  InvoiceRefundInput,
} from "./invoice-calculation.types.js";

/**
 * Unit tests for Task 19.2.1. The calculator is pure, so these tests need no
 * database: they pin the rounding policy and the validation rules that the
 * billing service will rely on.
 */

function expectValidationError(fn: () => unknown): void {
  let caught: unknown;

  try {
    fn();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
}

function payment(amount: string, status: InvoicePaymentInput["status"]): InvoicePaymentInput {
  return { amount, status };
}

describe("calculateInvoiceLine", () => {
  it("multiplies quantity by unit price and defaults to no discount or tax", () => {
    expect(calculateInvoiceLine({ quantity: 2, unitPrice: "150.00" })).toEqual({
      lineId: null,
      description: null,
      quantity: "2.000",
      unitPrice: "150.00",
      grossAmount: "300.00",
      discountAmount: "0.00",
      taxableAmount: "300.00",
      taxRate: "0.0000",
      taxAmount: "0.00",
      lineTotal: "300.00",
    });
  });

  it("applies a fixed item discount before tax", () => {
    const line = calculateInvoiceLine({
      lineId: "line-1",
      description: "Consultation",
      quantity: 1,
      unitPrice: "100.00",
      discount: { type: "AMOUNT", value: "10.00" },
      taxRate: "7.5",
    });

    expect(line).toMatchObject({
      lineId: "line-1",
      description: "Consultation",
      grossAmount: "100.00",
      discountAmount: "10.00",
      taxableAmount: "90.00",
      taxRate: "7.5000",
      taxAmount: "6.75",
      lineTotal: "96.75",
    });
  });

  it("applies a percentage item discount with half-up cent rounding", () => {
    // 3 x 19.99 = 59.97; 10% = 5.997 -> 6.00; 5% of 53.97 = 2.6985 -> 2.70.
    const line = calculateInvoiceLine({
      quantity: "3",
      unitPrice: "19.99",
      discount: { type: "PERCENTAGE", value: "10" },
      taxRate: "5",
    });

    expect(line).toMatchObject({
      grossAmount: "59.97",
      discountAmount: "6.00",
      taxableAmount: "53.97",
      taxAmount: "2.70",
      lineTotal: "56.67",
    });
  });

  it("rounds half-up at exactly half a cent", () => {
    const line = calculateInvoiceLine({ quantity: 1, unitPrice: "0.05", taxRate: "10" });

    expect(line.taxAmount).toBe("0.01");
    expect(line.lineTotal).toBe("0.06");
  });

  it("avoids binary floating-point drift", () => {
    // 0.1 * 0.2 is 0.020000000000000004 in IEEE 754 and 0.1 + 0.2 is 0.30000000000000004.
    const line = calculateInvoiceLine({ quantity: "0.1", unitPrice: "0.20" });
    expect(line.grossAmount).toBe("0.02");

    const invoice = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: "0.10" },
        { quantity: 1, unitPrice: "0.10" },
        { quantity: 1, unitPrice: "0.10" },
      ],
    });

    expect(invoice.subtotal).toBe("0.30");
    expect(invoice.totalAmount).toBe("0.30");
  });

  it("allows a hundred percent discount but no more", () => {
    const free = calculateInvoiceLine({
      quantity: 1,
      unitPrice: "40.00",
      discount: { type: "PERCENTAGE", value: "100" },
      taxRate: "20",
    });

    expect(free.discountAmount).toBe("40.00");
    expect(free.taxableAmount).toBe("0.00");
    expect(free.taxAmount).toBe("0.00");
    expect(free.lineTotal).toBe("0.00");
  });

  it("supports decimal quantities and zero quantity", () => {
    expect(calculateInvoiceLine({ quantity: "0", unitPrice: "99.99" }).lineTotal).toBe("0.00");
    expect(calculateInvoiceLine({ quantity: "1.5", unitPrice: "10.00" }).grossAmount).toBe(
      "15.00",
    );
  });
});

describe("calculateInvoice", () => {
  const input: InvoiceCalculationInput = {
    currency: "usd",
    lines: [
      { quantity: 2, unitPrice: "150.00", taxRate: "10" },
      {
        quantity: 1,
        unitPrice: "200.00",
        discount: { type: "AMOUNT", value: "50.00" },
        taxRate: "5",
      },
    ],
    payments: [
      payment("100.00", "SUCCESSFUL"),
      payment("200.00", "PENDING"),
      payment("50.00", "FAILED"),
      payment("137.50", "SUCCESSFUL"),
      payment("20.00", "REFUNDED"),
    ],
  };

  it("reconciles subtotal, discount, tax, total and balance due", () => {
    const invoice = calculateInvoice(input);

    expect(invoice).toMatchObject({
      currency: "USD",
      subtotal: "500.00",
      totalDiscount: "50.00",
      totalTax: "37.50",
      totalAmount: "487.50",
      // Only the two SUCCESSFUL payments settle money.
      amountPaid: "237.50",
      balanceDue: "250.00",
    });
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({ taxAmount: "30.00", lineTotal: "330.00" });
    expect(invoice.lines[1]).toMatchObject({ taxAmount: "7.50", lineTotal: "157.50" });
  });

  it("adds rounded line values so totals always reconcile with the lines", () => {
    const invoice = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: "0.05", taxRate: "10" },
        { quantity: 1, unitPrice: "0.05", taxRate: "10" },
        { quantity: 1, unitPrice: "0.05", taxRate: "10" },
      ],
    });

    // Each line taxes 0.005 up to 0.01; the invoice sums the rounded lines.
    expect(invoice.subtotal).toBe("0.15");
    expect(invoice.totalTax).toBe("0.03");
    expect(invoice.totalAmount).toBe("0.18");
    expect(invoice.balanceDue).toBe("0.18");
  });

  it("never lets pending or failed payments reduce the balance", () => {
    const invoice = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: "100.00" }],
      payments: [payment("100.00", "PENDING"), payment("100.00", "FAILED")],
    });

    expect(invoice.amountPaid).toBe("0.00");
    expect(invoice.balanceDue).toBe("100.00");
  });

  it("reports a zero balance instead of a negative amount when overpaid", () => {
    const invoice = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: "100.00" }],
      payments: [payment("120.00", "SUCCESSFUL")],
    });

    expect(invoice.amountPaid).toBe("120.00");
    expect(invoice.balanceDue).toBe("0.00");
  });

  it("keeps the line correlation fields", () => {
    const invoice = calculateInvoice({
      lines: [{ lineId: "item-1", description: "Dressing", quantity: 1, unitPrice: "5.00" }],
    });

    expect(invoice.lines[0]).toMatchObject({ lineId: "item-1", description: "Dressing" });
  });

  it("rejects empty invoices", () => {
    expectValidationError(() => calculateInvoice({ lines: [] }));
  });

  it("rejects payments in another currency", () => {
    expectValidationError(() =>
      calculateInvoice({
        currency: "EUR",
        lines: [{ quantity: 1, unitPrice: "10.00" }],
        payments: [{ amount: "10.00", status: "SUCCESSFUL", currency: "USD" }],
      }),
    );
  });
});

describe("calculateBalanceDue", () => {
  it("subtracts only successful payments", () => {
    expect(
      calculateBalanceDue("100.00", [
        payment("30.00", "SUCCESSFUL"),
        payment("70.00", "PENDING"),
      ]),
    ).toBe("70.00");
  });

  it("returns the full total without payments", () => {
    expect(calculateBalanceDue("100.00")).toBe("100.00");
  });

  it("settles at zero when fully paid", () => {
    expect(
      calculateBalanceDue("100.00", [
        payment("30.00", "SUCCESSFUL"),
        payment("70.00", "SUCCESSFUL"),
      ]),
    ).toBe("0.00");
  });
});

describe("calculateInvoiceBalance", () => {
  function refund(amount: string, status: InvoiceRefundInput["status"]): InvoiceRefundInput {
    return { amount, status };
  }

  it("settles successful payments and ignores pending or failed ones", () => {
    expect(
      calculateInvoiceBalance({
        totalAmount: "100.00",
        payments: [payment("40.00", "SUCCESSFUL"), payment("60.00", "PENDING")],
      }),
    ).toEqual({
      currency: "USD",
      totalAmount: "100.00",
      amountPaid: "40.00",
      refundedAmount: "0.00",
      balanceDue: "60.00",
    });
  });

  it("reduces net paid money by successful refunds only", () => {
    expect(
      calculateInvoiceBalance({
        totalAmount: "100.00",
        payments: [payment("100.00", "SUCCESSFUL")],
        refunds: [refund("25.00", "SUCCESSFUL"), refund("75.00", "FAILED")],
      }),
    ).toMatchObject({ amountPaid: "75.00", refundedAmount: "25.00", balanceDue: "25.00" });
  });

  it("rejects refunds larger than the money collected", () => {
    expectValidationError(() =>
      calculateInvoiceBalance({
        totalAmount: "100.00",
        payments: [payment("20.00", "SUCCESSFUL")],
        refunds: [refund("20.01", "SUCCESSFUL")],
      }),
    );
  });

  it("rejects unknown refund states and mismatched currencies", () => {
    expectValidationError(() =>
      calculateInvoiceBalance({
        totalAmount: "100.00",
        refunds: [{ amount: "10.00", status: "SETTLED" as never }],
      }),
    );
    expectValidationError(() =>
      calculateInvoiceBalance({
        totalAmount: "100.00",
        currency: "USD",
        refunds: [{ amount: "10.00", status: "SUCCESSFUL", currency: "EUR" }],
      }),
    );
  });

  it("keeps fractional cent arithmetic exact", () => {
    expect(
      calculateInvoiceBalance({
        totalAmount: "0.32",
        payments: [payment("0.10", "SUCCESSFUL"), payment("0.11", "SUCCESSFUL")],
      }),
    ).toMatchObject({ amountPaid: "0.21", balanceDue: "0.11" });
  });
});

describe("financial validation", () => {
  const validLine = { quantity: 1, unitPrice: "10.00" };

  it("rejects negative quantities, prices, discounts and tax rates", () => {
    expectValidationError(() => calculateInvoiceLine({ quantity: "-1", unitPrice: "10.00" }));
    expectValidationError(() => calculateInvoiceLine({ quantity: 1, unitPrice: "-0.01" }));
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "AMOUNT", value: "-1.00" },
      }),
    );
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "PERCENTAGE", value: "-5" },
      }),
    );
    expectValidationError(() => calculateInvoiceLine({ ...validLine, taxRate: "-1" }));
  });

  it("rejects invalid tax and discount rates", () => {
    expectValidationError(() => calculateInvoiceLine({ ...validLine, taxRate: "100.0001" }));
    expectValidationError(() => calculateInvoiceLine({ ...validLine, taxRate: "abc" }));
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "PERCENTAGE", value: "101" },
      }),
    );
  });

  it("rejects discounts larger than the amount they apply to", () => {
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "AMOUNT", value: "10.01" },
      }),
    );
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "PERCENTAGE", value: "100.01" },
      }),
    );
  });

  it("rejects more decimals than the NUMERIC columns hold", () => {
    expectValidationError(() => calculateInvoiceLine({ quantity: "1.0001", unitPrice: "10.00" }));
    expectValidationError(() => calculateInvoiceLine({ quantity: 1, unitPrice: "10.999" }));
    expectValidationError(() => calculateInvoiceLine({ ...validLine, taxRate: "7.55555" }));
  });

  it("rejects malformed and non-finite numbers", () => {
    expectValidationError(() => calculateInvoiceLine({ quantity: 1, unitPrice: "1e3" }));
    expectValidationError(() => calculateInvoiceLine({ quantity: 1, unitPrice: "" }));
    expectValidationError(() => calculateInvoiceLine({ quantity: 1, unitPrice: "12,50" }));
    expectValidationError(() =>
      calculateInvoiceLine({ quantity: 1, unitPrice: Number.POSITIVE_INFINITY }),
    );
    expectValidationError(() => calculateInvoiceLine({ quantity: Number.NaN, unitPrice: "1" }));
  });

  it("rejects unknown discount types and payment states", () => {
    expectValidationError(() =>
      calculateInvoiceLine({
        ...validLine,
        discount: { type: "BOGO" as never, value: "1" },
      }),
    );
    expectValidationError(() =>
      calculateInvoice({
        lines: [validLine],
        payments: [{ amount: "10.00", status: "SETTLED" as never }],
      }),
    );
  });

  it("rejects amounts that would overflow NUMERIC(12, 2)", () => {
    expectValidationError(() =>
      calculateInvoiceLine({ quantity: "2", unitPrice: "9999999999.99" }),
    );
    expectValidationError(() => calculateBalanceDue("-1.00"));
  });

  it("rejects invalid currency codes", () => {
    expectValidationError(() => calculateInvoice({ currency: "US", lines: [validLine] }));
  });
});
