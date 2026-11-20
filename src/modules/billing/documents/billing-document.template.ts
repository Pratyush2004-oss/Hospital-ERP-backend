import PDFDocument from "pdfkit";
import type {
  BillingDocumentModel,
  DocumentTable,
  DocumentTableColumn,
} from "./billing-document.model.js";
import type { BillingDocumentRenderer } from "./billing-document.types.js";

/**
 * Reusable PDF layout for every billing document (Phase 19.8.1).
 *
 * PDFKit draws only the provider-independent model: it never reads the database
 * and never formats raw financial values, so invoice, receipt and credit note
 * share one layout and the money strings come from the decimal-safe calculator.
 *
 * Privacy: the PDF `Title`/`Subject` metadata never contains a patient name,
 * and the renderer writes no logs. Only patient name and MRN appear on the page.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 34;

const COLORS = {
  primary: "#1f3b57",
  accent: "#2f6f8f",
  text: "#1f2937",
  muted: "#6b7280",
  border: "#d1d5db",
  surface: "#f3f6f9",
  white: "#ffffff",
} as const;

/** PDFKit's standard fonts cover WinAnsi; map common typography, drop the rest. */
function safeText(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u20ac/g, "EUR")
    .replace(/\u00a0/g, " ")
    .replace(/[^\u0009\u000a\u000d\u0020-\u00ff]/g, "?");
}

function moneyLine(currency: string, value: string): string {
  return safeText(`${currency} ${value}`);
}

function formatGeneratedAt(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(value);
}

function drawRule(doc: PDFKit.PDFDocument, y: number, color: string = COLORS.border): void {
  doc
    .save()
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.7)
    .strokeColor(color)
    .stroke()
    .restore();
}

function drawHeader(doc: PDFKit.PDFDocument, model: BillingDocumentModel): number {
  let textLeft = MARGIN;

  if (model.logo !== null) {
    try {
      doc.image(model.logo, MARGIN, MARGIN, { fit: [56, 56] });
      textLeft = MARGIN + 68;
    } catch {
      // A broken/unreadable logo must never block a financial document.
      textLeft = MARGIN;
    }
  }

  doc
    .fillColor(COLORS.primary)
    .font("Helvetica-Bold")
    .fontSize(17)
    .text(safeText(model.hospitalName), textLeft, MARGIN, { width: 300, lineBreak: false });

  let lineY = MARGIN + 21;

  if (model.hospitalLegalName !== null) {
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(safeText(model.hospitalLegalName), textLeft, lineY, {
        width: 300,
        lineBreak: false,
      });
    lineY += 12;
  }

  if (model.hospitalContact.length > 0) {
    doc
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(safeText(model.hospitalContact.join("  |  ")), textLeft, lineY, {
        width: 320,
      });
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(COLORS.accent)
    .text("HOSPITALOS BILLING", MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: "right",
      lineBreak: false,
    });

  drawRule(doc, MARGIN + 66);
  doc.y = MARGIN + 78;

  return doc.y;
}

function drawTitle(doc: PDFKit.PDFDocument, model: BillingDocumentModel): void {
  const top = doc.y;

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(COLORS.primary)
    .text(safeText(model.title), MARGIN, top, { width: 300, lineBreak: false });

  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(COLORS.muted)
    .text(safeText(model.subtitle), MARGIN, top + 27, { width: 300, lineBreak: false });

  // Document number and status chip, right aligned.
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.text)
    .text(safeText(model.documentNumber), MARGIN + 320, top + 2, {
      width: CONTENT_WIDTH - 320,
      align: "right",
      lineBreak: false,
    });

  const status = safeText(model.status);
  const statusWidth = doc.font("Helvetica-Bold").fontSize(7.5).widthOfString(status) + 14;
  const statusX = MARGIN + CONTENT_WIDTH - statusWidth;
  const statusY = top + 20;

  doc
    .save()
    .roundedRect(statusX, statusY, statusWidth, 15, 7)
    .fillColor(COLORS.surface)
    .fill()
    .restore();

  doc
    .fillColor(COLORS.accent)
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .text(status, statusX, statusY + 4, { width: statusWidth, align: "center", lineBreak: false });

  doc.y = top + 48;
}

function drawParties(doc: PDFKit.PDFDocument, model: BillingDocumentModel): void {
  const gap = 20;
  const width = (CONTENT_WIDTH - gap) / 2;
  const parties = model.parties.slice(0, 4);
  let leftY = doc.y;
  let rightY = doc.y;

  parties.forEach((party, index) => {
    const columnX = index % 2 === 0 ? MARGIN : MARGIN + width + gap;
    const startY = index % 2 === 0 ? leftY : rightY;

    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(COLORS.accent)
      .text(safeText(party.heading.toUpperCase()), columnX, startY, {
        width,
        lineBreak: false,
      });

    let y = startY + 12;

    for (const line of party.lines) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLORS.text)
        .text(safeText(line), columnX, y, { width });

      y = doc.y + 2;
    }

    if (index % 2 === 0) leftY = y + 8;
    else rightY = y + 8;
  });

  doc.y = Math.max(leftY, rightY) + 4;
}

function drawMetadata(doc: PDFKit.PDFDocument, model: BillingDocumentModel): void {
  if (model.metadata.length === 0) return;

  const top = doc.y;
  const labelWidth = 95;
  const valueWidth = CONTENT_WIDTH / 2 - labelWidth - 16;
  let y = top;

  model.metadata.forEach((entry, index) => {
    const columnX = index % 2 === 0 ? MARGIN : MARGIN + CONTENT_WIDTH / 2;

    if (index % 2 === 0 && index > 0) y += 16;

    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(safeText(entry.label), columnX, y, { width: labelWidth, lineBreak: false });

    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(COLORS.text)
      .text(safeText(entry.value), columnX + labelWidth, y, {
        width: valueWidth,
        lineBreak: false,
      });
  });

  doc.y = y + 24;
  drawRule(doc, doc.y - 8, COLORS.surface);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed <= PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) return;
  doc.addPage();
}

function columnWidths(columns: readonly DocumentTableColumn[]): number[] {
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  return columns.map((column) => (column.width / total) * CONTENT_WIDTH);
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  table: DocumentTable,
  widths: readonly number[],
): void {
  const height = 18;
  const top = doc.y;

  doc.save().rect(MARGIN, top, CONTENT_WIDTH, height).fillColor(COLORS.surface).fill().restore();

  let x = MARGIN;

  table.columns.forEach((column, index) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(COLORS.primary)
      .text(safeText(column.label.toUpperCase()), x + 5, top + 6, {
        width: (widths[index] ?? 0) - 10,
        align: column.align,
        lineBreak: false,
      });

    x += widths[index] ?? 0;
  });

  doc.y = top + height;
}

function drawTable(doc: PDFKit.PDFDocument, table: DocumentTable): void {
  ensureSpace(doc, 60);

  if (table.title !== undefined) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(COLORS.primary)
      .text(safeText(table.title), MARGIN, doc.y, { width: CONTENT_WIDTH, lineBreak: false });
    doc.y += 16;
  }

  const widths = columnWidths(table.columns);
  drawTableHeader(doc, table, widths);

  table.rows.forEach((row, rowIndex) => {
    const cellHeights = table.columns.map((column, index) =>
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .heightOfString(safeText(row[column.key] ?? ""), {
          width: (widths[index] ?? 0) - 10,
        }),
    );
    const height = Math.max(18, Math.max(...cellHeights) + 8);

    ensureSpace(doc, height + 4);

    const top = doc.y;

    if (rowIndex % 2 === 1) {
      doc
        .save()
        .rect(MARGIN, top, CONTENT_WIDTH, height)
        .fillColor("#fafbfc")
        .fill()
        .restore();
    }

    let x = MARGIN;

    table.columns.forEach((column, index) => {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(COLORS.text)
        .text(safeText(row[column.key] ?? ""), x + 5, top + 5, {
          width: (widths[index] ?? 0) - 10,
          align: column.align,
        });

      x += widths[index] ?? 0;
    });

    doc
      .save()
      .moveTo(MARGIN, top + height)
      .lineTo(MARGIN + CONTENT_WIDTH, top + height)
      .lineWidth(0.4)
      .strokeColor(COLORS.border)
      .stroke()
      .restore();

    doc.y = top + height;
  });

  doc.y += 14;
}

function drawSummary(doc: PDFKit.PDFDocument, model: BillingDocumentModel): void {
  const blockWidth = 250;
  const blockX = MARGIN + CONTENT_WIDTH - blockWidth;
  const rowHeight = 17;
  const needed = model.summary.length * rowHeight + 8;

  ensureSpace(doc, needed);

  let y = doc.y;

  for (const row of model.summary) {
    if (row.emphasis === true) {
      doc
        .save()
        .rect(blockX - 6, y - 2, blockWidth + 6, rowHeight)
        .fillColor(COLORS.surface)
        .fill()
        .restore();
    }

    doc
      .font(row.emphasis === true ? "Helvetica-Bold" : "Helvetica")
      .fontSize(row.emphasis === true ? 9.5 : 9)
      .fillColor(row.emphasis === true ? COLORS.primary : COLORS.text)
      .text(safeText(row.label), blockX, y + 3, { width: blockWidth - 115, lineBreak: false });

    doc
      .font(row.emphasis === true ? "Helvetica-Bold" : "Helvetica")
      .fontSize(row.emphasis === true ? 9.5 : 9)
      .fillColor(row.emphasis === true ? COLORS.primary : COLORS.text)
      .text(moneyLine(model.currency, row.value), blockX + 130, y + 3, {
        width: blockWidth - 130,
        align: "right",
        lineBreak: false,
      });

    y += rowHeight;
  }

  doc.y = y + 12;
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  model: BillingDocumentModel,
  page: number,
  total: number,
): void {
  const y = PAGE_HEIGHT - MARGIN - 12;

  doc
    .save()
    .moveTo(MARGIN, y - 12)
    .lineTo(MARGIN + CONTENT_WIDTH, y - 12)
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke()
    .restore();

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text(safeText(model.footerNote), MARGIN, y, {
      width: CONTENT_WIDTH - 150,
      lineBreak: false,
    });

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text(
      `Generated ${formatGeneratedAt(model.generatedAt)}  |  Page ${page} of ${total}`,
      MARGIN + CONTENT_WIDTH - 260,
      y,
      { width: 260, align: "right", lineBreak: false },
    );
}

/** Renders one billing document to a PDF buffer. */
export async function renderBillingDocumentPdf(model: BillingDocumentModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    bufferPages: true,
    info: {
      // No patient name in metadata: document type and number identify it.
      Title: `${model.title} ${model.documentNumber}`,
      Author: model.hospitalName,
      Subject: model.subtitle,
      Creator: "HospitalOS",
      Producer: "HospitalOS",
    },
  });

  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (error: Error) => reject(error));
  });

  drawHeader(doc, model);
  drawTitle(doc, model);
  drawParties(doc, model);
  drawMetadata(doc, model);

  for (const table of model.tables) {
    drawTable(doc, table);
  }

  drawSummary(doc, model);

  const range = doc.bufferedPageRange();

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    drawFooter(doc, model, index + 1, range.count);
  }

  doc.end();

  return completed;
}

export const pdfKitBillingDocumentRenderer: BillingDocumentRenderer = {
  render: renderBillingDocumentPdf,
};
