// Stamps buyer details onto every page of a PDF plus hidden metadata.
// Returns a Buffer of the per-buyer PDF. The master buffer is never modified.
//
// No buyer name is collected at checkout (email + EcoCash number only), so
// the watermark identifies the buyer by email and order reference.
const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");

async function watermarkPdf(masterPdfBuffer, buyer) {
  const pdf = await PDFDocument.load(masterPdfBuffer);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const footer = `Licensed to ${buyer.email} · Order ${buyer.orderRef} · ${buyer.date}`;
  const diag = `${buyer.email}  ${buyer.orderRef}`;

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    page.drawText(footer, { x: 36, y: 20, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    const size = Math.max(18, Math.min(34, width / 18));
    const w = font.widthOfTextAtSize(diag, size);
    page.drawText(diag, {
      x: width / 2 - w / 2 + 40, y: height / 2 - 60, size, font,
      color: rgb(0.6, 0.6, 0.6), opacity: 0.18, rotate: degrees(35),
    });
  }
  pdf.setSubject(`Order ${buyer.orderRef} licensed to ${buyer.email}`);
  pdf.setKeywords([buyer.email, buyer.orderRef, buyer.date]);
  pdf.setModificationDate(new Date());
  return Buffer.from(await pdf.save());
}

module.exports = { watermarkPdf };
