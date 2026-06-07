import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { PaymentLineItem, PaymentRow } from "@workspace/db";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_LABEL: Record<string, string> = {
  pending: "Menunggu Pembayaran",
  paid: "Lunas",
  expired: "Kedaluwarsa",
  failed: "Gagal",
};

export interface InvoiceBank {
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
}

export interface InvoiceData {
  payment: Pick<
    PaymentRow,
    | "id"
    | "kind"
    | "amountIdr"
    | "status"
    | "provider"
    | "externalId"
    | "quantity"
    | "createdAt"
    | "paidAt"
  >;
  lineItems: PaymentLineItem[];
  ownerName: string;
  ownerEmail: string;
  bank?: InvoiceBank | null;
  businessName?: string;
}

// Build a downloadable PDF invoice for a single payment (cart or legacy single
// item). Pure pdf-lib (no external image fetches) so it never fails on network.
export async function buildInvoicePdf(data: InvoiceData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 48;
  const PRICE_RIGHT = PAGE_W - MARGIN;
  const contentLeft = MARGIN;

  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.42, 0.46, 0.52);
  const accent = rgb(0.15, 0.55, 0.42);
  const lineColor = rgb(0.85, 0.87, 0.9);

  const text = (
    s: string,
    x: number,
    yy: number,
    size: number,
    f: PDFFont = font,
    color = ink
  ) => page.drawText(s, { x, y: yy, size, font: f, color });

  const textRight = (
    s: string,
    right: number,
    yy: number,
    size: number,
    f: PDFFont = font,
    color = ink
  ) => {
    const w = f.widthOfTextAtSize(s, size);
    page.drawText(s, { x: right - w, y: yy, size, font: f, color });
  };

  // --- Header -----------------------------------------------------------
  text(data.businessName ?? "MaxiChat", contentLeft, y - 4, 20, fontBold, accent);
  textRight("INVOICE", PRICE_RIGHT, y - 2, 22, fontBold, ink);
  y -= 26;
  textRight(`No. INV-${data.payment.id}`, PRICE_RIGHT, y, 10, font, muted);
  y -= 28;

  page.drawLine({
    start: { x: contentLeft, y },
    end: { x: PRICE_RIGHT, y },
    thickness: 1,
    color: lineColor,
  });
  y -= 24;

  // --- Meta (billed-to + payment meta) ----------------------------------
  const metaTop = y;
  text("Ditagihkan kepada", contentLeft, metaTop, 9, fontBold, muted);
  text(data.ownerName || data.ownerEmail || "-", contentLeft, metaTop - 16, 11, fontBold);
  if (data.ownerEmail) {
    text(data.ownerEmail, contentLeft, metaTop - 32, 10, font, muted);
  }

  const rightColX = MARGIN + 320;
  const metaRow = (label: string, value: string, rowY: number) => {
    text(label, rightColX, rowY, 9, font, muted);
    textRight(value, PRICE_RIGHT, rowY, 10, fontBold);
  };
  metaRow("Tanggal", dateFmt.format(new Date(data.payment.createdAt)), metaTop);
  metaRow(
    "Status",
    STATUS_LABEL[data.payment.status] ?? data.payment.status,
    metaTop - 16
  );
  metaRow(
    "Metode",
    data.payment.provider === "manual" ? "Transfer Bank" : "Xendit",
    metaTop - 32
  );
  if (data.payment.externalId) {
    metaRow("Kode", data.payment.externalId, metaTop - 48);
  }

  y = metaTop - 70;

  // --- Line items table -------------------------------------------------
  const COL_DESC = contentLeft;
  const COL_QTY = MARGIN + 300;
  const COL_PRICE = MARGIN + 360;
  const ROW_H = 22;

  // Header band.
  page.drawRectangle({
    x: contentLeft,
    y: y - 6,
    width: PRICE_RIGHT - contentLeft,
    height: 22,
    color: rgb(0.96, 0.97, 0.98),
  });
  text("Deskripsi", COL_DESC + 8, y, 9, fontBold, muted);
  text("Qty", COL_QTY, y, 9, fontBold, muted);
  text("Harga", COL_PRICE, y, 9, fontBold, muted);
  textRight("Subtotal", PRICE_RIGHT - 8, y, 9, fontBold, muted);
  y -= ROW_H;

  // Rows. Fall back to a single synthesised line for legacy non-cart rows.
  const rows: PaymentLineItem[] =
    data.lineItems.length > 0
      ? data.lineItems
      : [
          {
            kind: "addon",
            refId: 0,
            quantity: data.payment.quantity,
            name: "Pembelian MaxiChat",
            unitPriceIdr: data.payment.amountIdr,
            lineAmountIdr: data.payment.amountIdr,
          },
        ];

  for (const li of rows) {
    text(li.name, COL_DESC + 8, y, 10, font, ink);
    text(String(li.quantity), COL_QTY, y, 10, font, ink);
    text(IDR.format(li.unitPriceIdr), COL_PRICE, y, 10, font, ink);
    textRight(IDR.format(li.lineAmountIdr), PRICE_RIGHT - 8, y, 10, font, ink);
    y -= ROW_H;
    page.drawLine({
      start: { x: contentLeft, y: y + 6 },
      end: { x: PRICE_RIGHT, y: y + 6 },
      thickness: 0.5,
      color: lineColor,
    });
  }

  // --- Total ------------------------------------------------------------
  y -= 10;
  text("Total", COL_PRICE, y, 12, fontBold, ink);
  textRight(IDR.format(data.payment.amountIdr), PRICE_RIGHT - 8, y, 13, fontBold, accent);
  y -= 36;

  // --- Manual bank details (if pending bank transfer) -------------------
  if (
    data.payment.provider === "manual" &&
    data.payment.status === "pending" &&
    data.bank &&
    (data.bank.bankName || data.bank.bankAccountNumber)
  ) {
    page.drawRectangle({
      x: contentLeft,
      y: y - 70,
      width: PRICE_RIGHT - contentLeft,
      height: 80,
      color: rgb(0.97, 0.98, 0.97),
      borderColor: lineColor,
      borderWidth: 1,
    });
    text("Instruksi Pembayaran", contentLeft + 12, y - 8, 10, fontBold, accent);
    let by = y - 26;
    if (data.bank.bankName) {
      text(`Bank: ${data.bank.bankName}`, contentLeft + 12, by, 10, font, ink);
      by -= 15;
    }
    if (data.bank.bankAccountNumber) {
      text(
        `No. Rekening: ${data.bank.bankAccountNumber}`,
        contentLeft + 12,
        by,
        10,
        font,
        ink
      );
      by -= 15;
    }
    if (data.bank.bankAccountHolder) {
      text(
        `Atas Nama: ${data.bank.bankAccountHolder}`,
        contentLeft + 12,
        by,
        10,
        font,
        ink
      );
    }
    y -= 96;
  }

  // --- Footer -----------------------------------------------------------
  text(
    "Terima kasih telah berlangganan MaxiChat.",
    contentLeft,
    MARGIN + 8,
    9,
    font,
    muted
  );

  return doc.save();
}
