// Stamps buyer details onto every page of a PDF plus hidden metadata.
// Returns a Buffer of the per-buyer PDF. The master buffer is never modified.
//
// Also exports watermarkPageImage, the closed-reader equivalent for a single
// rendered page image (build brief §3): the clean PNG cached in R2 at
// upload time is never sent as-is — this composites the buyer's watermark
// onto a fresh in-memory copy on every page view.
const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");
const sharp = require("sharp");

// watermarkPdf still accepts the *whole-document* delivery path used for the
// emailed purchase copy (fulfil() in server.js) — masterPdfBuffer is the
// master PDF's bytes, already fetched from R2 by the caller.
async function watermarkPdf(masterPdfBuffer, buyer) {
  const pdf = await PDFDocument.load(masterPdfBuffer);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const footer = `Licensed to ${buyer.name} (${buyer.email}) · Order ${buyer.orderRef} · ${buyer.date}`;
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

// Escapes text for safe interpolation into the SVG we composite below.
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Composites a footer line and a faint diagonal identity stamp onto a single
// clean page PNG. `reader` identifies the account viewing the page — the
// reader is always logged in by the time this runs (server.js checks
// entitlement first), so this is what makes a screenshot traceable to one
// account even though the image itself carries no encryption (build brief
// §2–§3: the raster image is the whole security model here, so every image
// that leaves the server must carry this).
async function watermarkPageImage(cleanPngBuffer, reader) {
  const image = sharp(cleanPngBuffer);
  const { width, height } = await image.metadata();
  const footer = escapeXml(`${reader.username} · ${reader.date}`);
  const diag = escapeXml(reader.username);
  const diagSize = Math.max(16, Math.min(30, width / 16));

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="12" y="${height - 10}" font-family="Helvetica, Arial, sans-serif" font-size="11"
            fill="rgba(80,80,80,0.65)">${footer}</text>
      <g transform="translate(${width / 2}, ${height / 2}) rotate(-35)" opacity="0.16">
        <text text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${diagSize}"
              fill="rgb(90,90,90)">${diag}</text>
      </g>
    </svg>`;

  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { watermarkPdf, watermarkPageImage };
