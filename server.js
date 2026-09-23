require("dotenv").config();
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Paynow } = require("paynow");
const { prisma } = require("./db");
const { putObject, getObjectBuffer, deleteObject } = require("./storage");
const { watermarkPdf } = require("./watermark");
const { sendPdf } = require("./mailer");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEMO_MODE = process.env.DEMO_MODE === "true";

// Only settings.json (store name/tagline, admin password) still lives on
// local disk — it isn't part of the Postgres schema. That means it's still
// subject to Render's ephemeral-disk wipe: known gap, not fixed here (see
// docs/build-brief.md).
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

// ---------- tiny JSON store (settings only — see note above) ----------
const db = {
  read(name, fallback) {
    const p = path.join(DATA, `${name}.json`);
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
  },
  write(name, value) {
    fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(value, null, 2));
  },
};
const settings = () => db.read("settings", {});

// ---------- admin password: settings.json first, env var as fallback ----------
function hash(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}
function passwordIsSet() {
  return Boolean(settings().passwordHash || process.env.ADMIN_PASSWORD);
}
function passwordMatches(pw) {
  const s = settings();
  if (s.passwordHash) return crypto.timingSafeEqual(Buffer.from(hash(pw, s.salt)), Buffer.from(s.passwordHash));
  if (process.env.ADMIN_PASSWORD) return pw === process.env.ADMIN_PASSWORD;
  return false;
}
function setPassword(pw) {
  const s = settings();
  s.salt = crypto.randomBytes(16).toString("hex");
  s.passwordHash = hash(pw, s.salt);
  db.write("settings", s);
}

// ---------- creator passwords ----------
// Same scheme as admin's settings.json password, but per-row: the salt is
// embedded in the stored value as "salt:hash" since Creator only has one
// passwordHash column.
function hashCreatorPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyCreatorPassword(pw, stored) {
  const [salt, storedHash] = String(stored || "").split(":");
  if (!salt || !storedHash) return false;
  const candidate = crypto.scryptSync(pw, salt, 64).toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash)); }
  catch { return false; }
}

const toNum = (decimal) => (decimal === null || decimal === undefined ? null : Number(decimal.toString()));

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https"), maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, "public")));

// ---------- uploads ----------
// Master PDFs and covers go to R2 (storage.js), never to local disk —
// Render's disk is wiped on restart/redeploy (README).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "pdf") return cb(null, file.mimetype === "application/pdf");
    return cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype));
  },
});

function makePaynow() {
  const pn = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
  pn.resultUrl = `${BASE_URL}/api/paynow/result`;
  pn.returnUrl = `${BASE_URL}/`;
  return pn;
}

// ---------- fulfilment ----------
// Direct download replaces the closed reader: the watermarked PDF is
// generated once at delivery time, saved to R2 under the order, and served
// straight from the confirmation page. Email is a backup channel only and
// must never block delivery — a failed send is logged, not fatal, and never
// flips a delivered order back to FAILED (see spec: "must never block the
// sale if it fails").
const emailPreviews = new Map(); // dev convenience only (Ethereal preview links), not real order data
const fulfillingNow = new Set(); // re-entrancy guard

async function fulfil(orderId) {
  if (fulfillingNow.has(orderId)) return;
  fulfillingNow.add(orderId);
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { product: true } });
    if (!order || order.status === "DELIVERED") return;

    const masterPdf = await getObjectBuffer(order.product.sourcePdfKey);
    const date = new Date().toISOString().slice(0, 10);
    const pdf = await watermarkPdf(masterPdf, { email: order.email, orderRef: order.ref, date });

    const watermarkedPdfKey = `orders/${order.id}/delivery.pdf`;
    await putObject(watermarkedPdfKey, pdf, "application/pdf");
    const downloadToken = crypto.randomBytes(24).toString("hex");

    const splitPct = Number(order.product.creatorSplitPct || 0);
    const amount = Number(order.amount);
    const creatorEarning = order.product.creatorId ? Math.round(amount * (splitPct / 100) * 100) / 100 : null;
    const storeEarning = Math.round((amount - (creatorEarning || 0)) * 100) / 100;

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "DELIVERED", deliveredAt: new Date(), error: null,
        watermarkedPdfKey, downloadToken, creatorEarning, storeEarning,
      },
    });
    console.log(`[order ${order.ref}] delivered (direct download ready)`);

    // Backup email — best-effort, never blocks or reverses delivery.
    try {
      const result = await sendPdf({
        to: order.email, name: order.email, productTitle: order.product.title, orderRef: order.ref,
        pdfBuffer: pdf, fileName: `${order.product.title.replace(/[^a-z0-9]+/gi, "-")}.pdf`,
        storeName: settings().storeName || "Store",
      });
      if (result && result.preview) emailPreviews.set(order.id, result.preview);
    } catch (err) {
      console.error(`[order ${order.ref}] backup email failed (order still delivered):`, err.message);
    }
  } catch (err) {
    console.error(`[order ${orderId}] delivery failed:`, err.message);
    await prisma.order.update({ where: { id: orderId }, data: { status: "FAILED", error: err.message } }).catch(() => {});
  } finally {
    fulfillingNow.delete(orderId);
  }
}

function publicOrder(o) {
  // Distinguishes "paid but delivery itself failed" (e.g. R2 was down when
  // watermarking/upload ran) from a payment that was simply cancelled or
  // declined — very different messages for the buyer, and very different
  // from a bounced backup email, which never touches order status at all
  // (see fulfil() in server.js).
  let status = String(o.status).toLowerCase();
  if (o.status === "FAILED" && o.paidAt) status = "delivery_failed";
  return {
    ref: o.ref, productId: o.productId, email: o.email, phone: o.phone,
    amount: toNum(o.amount), status, error: o.error, createdAt: o.createdAt,
    deliveredAt: o.deliveredAt,
    downloadUrl: o.status === "DELIVERED" ? `/api/orders/${o.ref}/download?token=${o.downloadToken}` : null,
    emailPreview: emailPreviews.get(o.id) || null,
  };
}

const publicProduct = (p) => ({
  id: p.id, title: p.title, description: p.description, price: toNum(p.price),
  categoryId: p.categoryId, cover: p.coverImageKey ? `/covers/${p.id}` : null,
});
const adminProductView = (p) => ({
  id: p.id, title: p.title, description: p.description, price: toNum(p.price),
  categoryId: p.categoryId, cover: p.coverImageKey ? `/covers/${p.id}` : null,
  published: p.published, createdAt: p.createdAt,
  creatorId: p.creatorId, creatorName: p.creator ? p.creator.name : null,
  creatorSplitPct: toNum(p.creatorSplitPct),
});

// ================= PUBLIC =================
app.get("/api/store", async (req, res) => {
  const [s, categories, products] = await Promise.all([
    Promise.resolve(settings()),
    prisma.category.findMany(),
    prisma.product.findMany({ where: { published: true }, orderBy: { createdAt: "desc" } }),
  ]);
  res.json({
    storeName: s.storeName || "Store",
    tagline: s.tagline || "",
    categories,
    products: products.map(publicProduct),
  });
});

// Cover images live in R2, not on local disk (see storage.js) — this streams
// them through rather than serving a static folder.
app.get("/covers/:productId", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product || !product.coverImageKey) return res.sendStatus(404);
    const buf = await getObjectBuffer(product.coverImageKey);
    const ext = (product.coverImageKey.match(/\.(\w+)$/) || [, "jpg"])[1].toLowerCase();
    const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800").send(buf);
  } catch (err) {
    console.error("cover fetch failed:", err.message);
    res.sendStatus(404);
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { productId, email, phone } = req.body || {};
    const product = await prisma.product.findFirst({ where: { id: productId, published: true } });
    if (!product) return res.status(400).json({ error: "Product not found." });
    if (!email || !phone) return res.status(400).json({ error: "Email and EcoCash number are required." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const cleanPhone = String(phone).replace(/\s/g, "");
    if (!/^0(77|78)\d{7}$/.test(cleanPhone)) return res.status(400).json({ error: "Enter a valid EcoCash number, e.g. 0771234567." });

    const ref = "ORD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const order = await prisma.order.create({
      data: {
        ref, productId: product.id,
        email: email.trim().toLowerCase(), phone: cleanPhone,
        amount: product.price, status: "PENDING",
      },
    });

    if (DEMO_MODE) {
      await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
      await fulfil(order.id);
      return res.json({ ref, instructions: "Demo mode: payment simulated. Your download is ready." });
    }
    try {
      const paynow = makePaynow();
      const payment = paynow.createPayment(ref, order.email);
      payment.add(product.title, toNum(product.price));
      const r = await paynow.sendMobile(payment, cleanPhone, "ecocash");
      if (!r || !r.success) {
        const errMsg = (r && r.error) || "Paynow rejected the request";
        await prisma.order.update({ where: { id: order.id }, data: { status: "FAILED", error: errMsg } });
        return res.status(502).json({ error: `Payment could not be started: ${errMsg}` });
      }
      await prisma.order.update({ where: { id: order.id }, data: { paynowPollUrl: r.pollUrl } });
      res.json({ ref, instructions: r.instructions || "Check your phone and enter your EcoCash PIN to approve." });
    } catch (err) {
      await prisma.order.update({ where: { id: order.id }, data: { status: "FAILED", error: err.message } });
      res.status(502).json({ error: `Payment could not be started: ${err.message}` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.get("/api/orders/:ref", async (req, res) => {
  let order = await prisma.order.findUnique({ where: { ref: req.params.ref } });
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "PENDING" && order.paynowPollUrl) {
    try {
      const st = await makePaynow().pollTransaction(order.paynowPollUrl);
      if (st.paid()) { await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } }); await fulfil(order.id); }
      else if (/cancel|fail/i.test(st.status || "")) await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    } catch (err) { console.error(`[order ${order.ref}] poll error:`, err.message); }
    order = await prisma.order.findUnique({ where: { ref: req.params.ref } });
  }
  res.json(publicOrder(order));
});

// Direct download / redownload — no account needed, just the per-order
// token handed out on the confirmation page (and in the backup email).
app.get("/api/orders/:ref/download", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { ref: req.params.ref }, include: { product: true } });
  if (!order || order.status !== "DELIVERED" || !order.watermarkedPdfKey) return res.sendStatus(404);
  if (!order.downloadToken || req.query.token !== order.downloadToken) return res.sendStatus(403);
  try {
    const buf = await getObjectBuffer(order.watermarkedPdfKey);
    const fileName = `${order.product.title.replace(/[^a-z0-9]+/gi, "-")}.pdf`;
    res.set("Content-Type", "application/pdf").set("Content-Disposition", `attachment; filename="${fileName}"`).send(buf);
  } catch (err) {
    console.error(`[order ${order.ref}] download failed:`, err.message);
    res.sendStatus(500);
  }
});

app.post("/api/paynow/result", async (req, res) => {
  res.sendStatus(200);
  const { reference, status, hash: h } = req.body || {};
  const order = reference && (await prisma.order.findUnique({ where: { ref: reference } }));
  if (!order || order.status !== "PENDING") return;
  const joined = Object.entries(req.body).filter(([k]) => k !== "hash").map(([, v]) => v).join("");
  const expected = crypto.createHash("sha512").update(joined + process.env.PAYNOW_INTEGRATION_KEY).digest("hex").toUpperCase();
  if (expected !== String(h).toUpperCase()) return console.warn(`[order ${reference}] bad hash, ignored`);
  if (/^paid$/i.test(status)) { await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } }); await fulfil(order.id); }
  else if (/cancel/i.test(status)) await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
});

// ================= CREATOR PORTAL =================
function requireCreator(req, res, next) {
  if (req.session.creatorId) return next();
  res.status(401).json({ error: "Sign in required." });
}

app.get("/creator", (req, res) => res.sendFile(path.join(__dirname, "public", "creator.html")));

// Self-serve first login (build brief decision): admin adds a creator with
// just name + username, no password. The first successful login with that
// username *sets* the password from whatever is submitted; every login
// after that verifies against it normally.
app.post("/api/creator/login", async (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!cleanUsername || !password || String(password).length < 6) {
    return res.status(400).json({ error: "Enter your username and a password of at least 6 characters." });
  }
  const creator = await prisma.creator.findUnique({ where: { username: cleanUsername } });
  if (!creator) return res.status(401).json({ error: "Unknown username." });

  if (!creator.passwordHash) {
    await prisma.creator.update({ where: { id: creator.id }, data: { passwordHash: hashCreatorPassword(password) } });
  } else if (!verifyCreatorPassword(password, creator.passwordHash)) {
    return res.status(401).json({ error: "Wrong password." });
  }
  req.session.creatorId = creator.id;
  req.session.creatorName = creator.name;
  res.json({ ok: true, name: creator.name, username: creator.username });
});
app.post("/api/creator/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/creator/session", (req, res) => {
  res.json({ loggedIn: Boolean(req.session.creatorId), name: req.session.creatorName || null });
});

app.get("/api/creator/products", requireCreator, async (req, res) => {
  const list = await prisma.product.findMany({ where: { creatorId: req.session.creatorId }, orderBy: { createdAt: "desc" } });
  res.json(list.map((p) => ({
    id: p.id, title: p.title, price: toNum(p.price), cover: p.coverImageKey ? `/covers/${p.id}` : null,
    published: p.published, splitPct: toNum(p.creatorSplitPct), createdAt: p.createdAt,
  })));
});

app.get("/api/creator/earnings", requireCreator, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: "DELIVERED", product: { creatorId: req.session.creatorId } },
    include: { product: true },
    orderBy: { deliveredAt: "desc" },
  });
  const total = orders.reduce((sum, o) => sum + Number(o.creatorEarning || 0), 0);
  res.json({
    total: Math.round(total * 100) / 100,
    orders: orders.map((o) => ({
      ref: o.ref, productTitle: o.product.title, amount: toNum(o.amount),
      earning: toNum(o.creatorEarning), deliveredAt: o.deliveredAt,
    })),
  });
});

// ================= ADMIN =================
function requireAdmin(req, res, next) {
  if (!passwordIsSet() || req.session.admin) return next();
  res.status(401).json({ error: "Sign in required." });
}

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/api/admin/session", (req, res) => {
  res.json({ passwordSet: passwordIsSet(), loggedIn: !passwordIsSet() || Boolean(req.session.admin), demoMode: DEMO_MODE });
});
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!passwordIsSet()) { req.session.admin = true; return res.json({ ok: true }); }
  if (!password || !passwordMatches(password)) return res.status(401).json({ error: "Wrong password." });
  req.session.admin = true;
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.post("/api/admin/password", requireAdmin, (req, res) => {
  const { current, next } = req.body || {};
  if (!next || next.length < 6) return res.status(400).json({ error: "Use at least 6 characters." });
  if (passwordIsSet() && !passwordMatches(current || "")) return res.status(401).json({ error: "Current password is wrong." });
  setPassword(next);
  req.session.admin = true;
  res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const { passwordHash, salt, ...pub } = settings();
  res.json(pub);
});
app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const s = settings();
  if (typeof req.body.storeName === "string") s.storeName = req.body.storeName.trim().slice(0, 60);
  if (typeof req.body.tagline === "string") s.tagline = req.body.tagline.trim().slice(0, 160);
  db.write("settings", s);
  res.json({ ok: true });
});

// Recorded-in-our-own-data revenue meter — NOT a live bank feed (build
// brief decision: there is no API connection to the real EcoCash/bank
// balance, this only reflects orders this app itself marked DELIVERED).
app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  const agg = await prisma.order.aggregate({ where: { status: "DELIVERED" }, _sum: { amount: true }, _count: true });
  res.json({ totalRevenue: toNum(agg._sum.amount) || 0, deliveredOrders: agg._count });
});

// categories
app.get("/api/admin/categories", requireAdmin, async (req, res) => res.json(await prisma.category.findMany()));
app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Category name is required." });
  try {
    res.json(await prisma.category.create({ data: { name } }));
  } catch (err) {
    if (err.code === "P2002") return res.status(400).json({ error: "That category already exists." });
    console.error(err);
    res.status(500).json({ error: "Could not create the category." });
  }
});
app.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  await prisma.$transaction([
    prisma.product.updateMany({ where: { categoryId: req.params.id }, data: { categoryId: null } }),
    prisma.category.delete({ where: { id: req.params.id } }),
  ]).catch(() => {});
  res.json({ ok: true });
});

// creators
app.get("/api/admin/creators", requireAdmin, async (req, res) => {
  const creators = await prisma.creator.findMany({ orderBy: { createdAt: "desc" } });
  const earnings = await prisma.order.groupBy({
    by: ["productId"], where: { status: "DELIVERED" }, _sum: { creatorEarning: true },
  });
  const products = await prisma.product.findMany({ where: { creatorId: { not: null } }, select: { id: true, creatorId: true } });
  const earningsByProduct = Object.fromEntries(earnings.map((e) => [e.productId, Number(e._sum.creatorEarning || 0)]));
  const earningsByCreator = {};
  for (const p of products) earningsByCreator[p.creatorId] = (earningsByCreator[p.creatorId] || 0) + (earningsByProduct[p.id] || 0);
  const productCountByCreator = {};
  for (const p of products) productCountByCreator[p.creatorId] = (productCountByCreator[p.creatorId] || 0) + 1;
  res.json(creators.map((c) => ({
    id: c.id, name: c.name, username: c.username, createdAt: c.createdAt,
    passwordSet: Boolean(c.passwordHash),
    productCount: productCountByCreator[c.id] || 0,
    totalEarnings: Math.round((earningsByCreator[c.id] || 0) * 100) / 100,
  })));
});
app.post("/api/admin/creators", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  if (!name) return res.status(400).json({ error: "Creator name is required." });
  if (!/^[a-z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Username: 3-30 characters, letters/numbers/underscore." });
  try {
    const creator = await prisma.creator.create({ data: { name, username } });
    res.json({ id: creator.id, name: creator.name, username: creator.username });
  } catch (err) {
    if (err.code === "P2002") return res.status(400).json({ error: "That username is already taken." });
    console.error(err);
    res.status(500).json({ error: "Could not create the creator." });
  }
});
app.delete("/api/admin/creators/:id", requireAdmin, async (req, res) => {
  await prisma.$transaction([
    prisma.product.updateMany({ where: { creatorId: req.params.id }, data: { creatorId: null, creatorSplitPct: 0 } }),
    prisma.creator.delete({ where: { id: req.params.id } }),
  ]).catch(() => {});
  res.json({ ok: true });
});

// products
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  const list = await prisma.product.findMany({ include: { creator: true }, orderBy: { createdAt: "desc" } });
  res.json(list.map(adminProductView));
});
app.post("/api/admin/products", requireAdmin, upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
  const { title, description, price, categoryId, creatorId, creatorSplitPct } = req.body;
  const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  if (!title || !(Number(price) > 0)) return res.status(400).json({ error: "Title and a price above zero are required." });
  if (!pdfFile) return res.status(400).json({ error: "Upload the PDF file." });
  const splitPct = creatorId ? Math.max(0, Math.min(100, Number(creatorSplitPct) || 0)) : 0;
  try {
    // Created with a placeholder sourcePdfKey to get an id, then updated
    // once the object key (which is derived from that id) is known.
    const product = await prisma.product.create({
      data: {
        title: title.trim(), description: (description || "").trim(),
        price: Number(Number(price).toFixed(2)), categoryId: categoryId || null,
        creatorId: creatorId || null, creatorSplitPct: splitPct,
        sourcePdfKey: "pending", published: false,
      },
    });
    const pdfKey = `products/${product.id}/source.pdf`;
    await putObject(pdfKey, pdfFile.buffer, "application/pdf");
    let coverKey = null;
    if (coverFile) {
      const ext = (coverFile.originalname.match(/\.\w+$/) || [".jpg"])[0];
      coverKey = `products/${product.id}/cover${ext}`;
      await putObject(coverKey, coverFile.buffer, coverFile.mimetype);
    }
    const updated = await prisma.product.update({
      where: { id: product.id }, data: { sourcePdfKey: pdfKey, coverImageKey: coverKey }, include: { creator: true },
    });
    res.json(adminProductView(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create the product." });
  }
});
app.put("/api/admin/products/:id", requireAdmin, upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: "Product not found." });
  const b = req.body;
  const data = {};
  if (b.title) data.title = b.title.trim();
  if (typeof b.description === "string") data.description = b.description.trim();
  if (b.price && Number(b.price) > 0) data.price = Number(Number(b.price).toFixed(2));
  if ("categoryId" in b) data.categoryId = b.categoryId || null;
  if ("creatorId" in b) {
    data.creatorId = b.creatorId || null;
    data.creatorSplitPct = data.creatorId ? Math.max(0, Math.min(100, Number(b.creatorSplitPct) || 0)) : 0;
  } else if ("creatorSplitPct" in b && product.creatorId) {
    data.creatorSplitPct = Math.max(0, Math.min(100, Number(b.creatorSplitPct) || 0));
  }
  if ("published" in b) data.published = b.published === "true" || b.published === true;

  const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  try {
    if (pdfFile) {
      await putObject(product.sourcePdfKey, pdfFile.buffer, "application/pdf");
    }
    if (coverFile) {
      if (product.coverImageKey) await deleteObject(product.coverImageKey).catch(() => {});
      const ext = (coverFile.originalname.match(/\.\w+$/) || [".jpg"])[0];
      data.coverImageKey = `products/${product.id}/cover${ext}`;
      await putObject(data.coverImageKey, coverFile.buffer, coverFile.mimetype);
    }
    const updated = await prisma.product.update({ where: { id: product.id }, data, include: { creator: true } });
    res.json(adminProductView(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the product." });
  }
});
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.json({ ok: true });
  try {
    await prisma.product.delete({ where: { id: product.id } });
  } catch (err) {
    if (err.code === "P2003") return res.status(400).json({ error: "This book has orders on it and can't be deleted. Unpublish it instead." });
    console.error(err);
    return res.status(500).json({ error: "Could not delete the product." });
  }
  if (product.sourcePdfKey) await deleteObject(product.sourcePdfKey).catch(() => {});
  if (product.coverImageKey) await deleteObject(product.coverImageKey).catch(() => {});
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const list = await prisma.order.findMany({ include: { product: true }, orderBy: { createdAt: "desc" } });
  res.json(list.map((o) => ({
    ...publicOrder(o), productTitle: o.product.title,
    creatorEarning: toNum(o.creatorEarning), storeEarning: toNum(o.storeEarning),
  })));
});

// upload errors as JSON
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 60 MB." : err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => console.log(`Store running on ${BASE_URL}${DEMO_MODE ? " (DEMO MODE)" : ""}`));
