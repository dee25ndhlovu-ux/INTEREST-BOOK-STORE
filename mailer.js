// Sends the watermarked PDF to the buyer.
//
// IMPORTANT: Render's free tier blocks outbound SMTP (ports 25/465/587) entirely, so
// nodemailer-over-SMTP hangs until timeout on Render even with correct credentials.
// This uses Brevo's HTTPS API instead (https://api.brevo.com), which travels over
// port 443 like any normal web request and is not blocked.
//
// Needs BREVO_API_KEY (from Brevo -> SMTP & API -> "API Keys & MCP" tab, a different
// key from the SMTP key). If it's not set, falls back to SMTP (fine for local testing
// on your own computer) and finally to a free Ethereal test inbox.

const nodemailer = require("nodemailer");

function parseFrom(fromEnv, fallbackName) {
  const m = /^(.*)<(.+)>$/.exec(fromEnv || "");
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() };
  return { name: fallbackName, email: fromEnv || "no-reply@example.com" };
}

async function sendViaBrevoApi({ to, name, productTitle, orderRef, pdfBuffer, fileName, storeName }) {
  const sender = parseFrom(process.env.FROM_EMAIL, storeName);
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender,
      to: [{ email: to, name }],
      subject: `Your copy of ${productTitle} (order ${orderRef})`,
      textContent: [
        `Hello ${name},`, ``,
        `Thank you for your purchase. Your copy of "${productTitle}" is attached.`, ``,
        `This copy is licensed to you personally and carries your name, email and order reference on every page. Please do not share it.`, ``,
        `Order reference: ${orderRef}`, ``, storeName,
      ].join("\n"),
      attachment: [{ content: pdfBuffer.toString("base64"), name: fileName }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brevo API rejected the email (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { messageId: data.messageId || null, preview: null };
}

// ---------- SMTP fallback (works locally; blocked on Render's free tier) ----------
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
        connectionTimeout: 10000,
      });
    }
    try {
      const t = await nodemailer.createTestAccount();
      usingEthereal = true;
      console.log("[mail] No email service configured. Using Ethereal test inbox:", t.user);
      return nodemailer.createTransport({ host: t.smtp.host, port: t.smtp.port, secure: t.smtp.secure, auth: { user: t.user, pass: t.pass } });
    } catch (err) {
      console.log("[mail] Ethereal unavailable, emails logged only:", err.message);
      return nodemailer.createTransport({ jsonTransport: true });
    }
  })();
  return transporterPromise;
}

async function sendViaSmtp({ to, name, productTitle, orderRef, pdfBuffer, fileName, storeName }) {
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

async function sendPdf(args) {
  if (process.env.BREVO_API_KEY) return sendViaBrevoApi(args);
  return sendViaSmtp(args);
}

module.exports = { sendPdf };
