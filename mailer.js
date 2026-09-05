// Emails the watermarked PDF. With no SMTP configured it uses a free Ethereal test
// inbox (preview link recorded on the order). If Ethereal is unreachable it logs only.
const nodemailer = require("nodemailer");

let transporterPromise = null;
let usingEthereal = false;

function getTransporter() {
  if (transporterPromise) return transporterPromise;
  transporterPromise = (async () => {
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    try {
      const t = await nodemailer.createTestAccount();
      usingEthereal = true;
      console.log("[mail] No SMTP set. Using Ethereal test inbox:", t.user);
      return nodemailer.createTransport({ host: t.smtp.host, port: t.smtp.port, secure: t.smtp.secure, auth: { user: t.user, pass: t.pass } });
    } catch (err) {
      console.log("[mail] Ethereal unavailable, emails logged only:", err.message);
      return nodemailer.createTransport({ jsonTransport: true });
    }
  })();
  return transporterPromise;
}

async function sendPdf({ to, name, productTitle, orderRef, pdfBuffer, fileName, storeName }) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: process.env.FROM_EMAIL || `${storeName} <no-reply@example.com>`,
    to,
    subject: `Your copy of ${productTitle} (order ${orderRef})`,
    text: [
      `Hello ${name},`, ``,
      `Thank you for your purchase. Your copy of "${productTitle}" is attached.`, ``,
      `This copy is licensed to you personally and carries your name, email and order reference on every page. Please do not share it.`, ``,
      `Order reference: ${orderRef}`, ``, storeName,
    ].join("\n"),
    attachments: [{ filename: fileName, content: pdfBuffer, contentType: "application/pdf" }],
  });
  const preview = usingEthereal ? nodemailer.getTestMessageUrl(info) : null;
  if (preview) console.log(`[mail] Preview for ${to}: ${preview}`);
  return { messageId: info.messageId, preview };
}

module.exports = { sendPdf };
