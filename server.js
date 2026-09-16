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
const { renderProduct, clearRenderedPages } = require("./render");
const { watermarkPdf, watermarkPageImage } = require("./watermark");
const { sendPdf } = require("./mailer");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEMO_MODE = process.env.DEMO_MODE === "true";

// Only settings.json (store name/tagline, admin password) still lives on
// local disk — it isn't part of the Postgres schema yet (build brief §8
// doesn't model it). That means it's still subject to the exact ephemeral-
// disk wipe the brief flagged for everything else: known gap, not fixed
// here (see docs/closed-reader-build-brief.md).
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

// ---------- account passwords (build brief §8) ----------
// Accounts only have one `passwordHash` column, so the salt is embedded in
// it as "salt:hash" rather than stored separately like settings.json above.
function hashAccountPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyAccountPassword(pw, stored) {
  const [salt, storedHash] = String(stored || "").split(":");
  if (!salt || !storedHash) return false;
  const candidate = crypto.scryptSync(pw, salt, 64).toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash)); }
  catch { return false; }
}

const toNum = (decimal) => Number(decimal.toString());

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
// Master PDFs, covers and rendered pages all go to R2 (storage.js), never to
// local disk — Render's disk is wiped on restart/redeploy (README, brief §8).
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
// Ethereal test-inbox preview links (DEMO/no-SMTP mode) aren't part of the
// Order schema — they're a dev convenience, not real order data, so they're
// kept in memory only (same as before this migration, when *all* orders
// were in-memory). Resets on restart; harmless.
const emailPreviews = new Map();
const fulfillingNow = new Set(); // re-entrancy guard now that fulfil() re-reads from the DB

async function fulfil(orderId) {
  if (fulfillingNow.has(orderId)) return;
  fulfillingNow.add(orderId);
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { product: true } });
    if (!order || order.status === "DELIVERED") return;
    const masterPdf = await getObjectBuffer(order.product.sourcePdfKey);
    const pdf = await watermarkPdf(masterPdf, {
      name: order.name, email: order.email, orderRef: order.ref, date: new Date().toISOString().slice(0, 10),
    });
    const result = await sendPdf({
      to: order.email, name: order.name, productTitle: order.product.title, orderRef: order.ref,
      pdfBuffer: pdf, fileName: `${order.product.title.replace(/[^a-z0-9]+/gi, "-")}.pdf`,
      storeName: settings().storeName || "PDF Store",
    });
    if (result && result.preview) emailPreviews.set(order.id, result.preview);
    await prisma.entitlement.upsert({
      where: { accountId_productId: { accountId: order.accountId, productId: order.productId } },
      create: { accountId: order.accountId, productId: order.productId },
      update: {},
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: new Date(), error: null } });
    console.log(`[order ${order.ref}] delivered to ${order.email}`);
  } catch (err) {
    console.error(`[order ${orderId}] delivery failed:`, err.message);
    await prisma.order.update({ where: { id: orderId }, data: { status: "FAILED", error: err.message } }).catch(() => {});
  } finally {
    fulfillingNow.delete(orderId);
  }
}

// Maps the DB's OrderStatus enum back to the lowercase strings the existing
// storefront JS already expects, including "delivery_failed" — which isn't
// its own enum value (the schema only has FAILED), but is distinguishable by
// whether payment had already succeeded (paidAt set) before the failure.
function publicOrder(o) {
  let status = String(o.status).toLowerCase();
  if (o.status === "FAILED" && o.paidAt) status = "delivery_failed";
  return {
    ref: o.ref, productId: o.productId, name: o.name, email: o.email, phone: o.phone,
    amount: toNum(o.amount), status, error: o.error, createdAt: o.createdAt,
    deliveredAt: o.deliveredAt, emailPreview: emailPreviews.get(o.id) || null,
  };
}

const publicProduct = (p) => ({
  id: p.id, title: p.title, description: p.description, price: toNum(p.price),
  categoryId: p.categoryId, cover: p.coverImageKey ? `/covers/${p.id}` : null,
});
const adminProductView = (p) => ({
  id: p.id, title: p.title, description: p.description, price: toNum(p.price),
  categoryId: p.categoryId, cover: p.coverImageKey ? `/covers/${p.id}` : null,
  published: p.published, renderStatus: p.renderStatus, pageCount: p.pageCount, createdAt: p.createdAt,
});

// ================= PUBLIC =================
app.get("/api/store", async (req, res) => {
  const [s, categories, products] = await Promise.all([
    Promise.resolve(settings()),
    prisma.category.findMany(),
    prisma.product.findMany({ where: { published: true, renderStatus: "READY" } }),
  ]);
  res.json({
    storeName: s.storeName || "PDF Store",
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
    const { productId, name, email, phone, username, password, recoveryEmail } = req.body || {};
    const product = await prisma.product.findFirst({ where: { id: productId, published: true, renderStatus: "READY" } });
    if (!product) return res.status(400).json({ error: "Product not found." });
    if (!name || !email || !phone) return res.status(400).json({ error: "Name, email and EcoCash number are required." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const cleanPhone = String(phone).replace(/\s/g, "");
    if (!/^0(77|78)\d{7}$/.test(cleanPhone)) return res.status(400).json({ error: "Enter a valid EcoCash number, e.g. 0771234567." });
    const cleanUsername = String(username || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(cleanUsername)) return res.status(400).json({ error: "Choose a username of 3-30 characters: letters, numbers, underscore." });
    if (!password || String(password).length < 6) return res.status(400).json({ error: "Choose a password of at least 6 characters." });

    // Accounts are created at checkout time, not from an email afterwards
    // (build brief §8, "Authentication and recovery"). A returning username
    // must supply its matching password to attach a new purchase to it.
    let account = await prisma.account.findUnique({ where: { username: cleanUsername } });
    if (account) {
      if (!verifyAccountPassword(password, account.passwordHash)) {
        return res.status(401).json({ error: "That username is already registered. Enter its password to add this purchase to the same account." });
      }
    } else {
      account = await prisma.account.create({
        data: {
          username: cleanUsername,
          passwordHash: hashAccountPassword(password),
          recoveryEmail: String(recoveryEmail || email).trim().toLowerCase(),
        },
      });
    }

    const ref = "ORD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const order = await prisma.order.create({
      data: {
        ref, accountId: account.id, productId: product.id,
        name: name.trim(), email: email.trim().toLowerCase(), phone: cleanPhone,
        amount: product.price, status: "PENDING",
      },
    });

    if (DEMO_MODE) {
      await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
      fulfil(order.id);
      return res.json({ ref, instructions: "Demo mode: payment simulated. Delivering your PDF now." });
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
      if (st.paid()) { await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } }); fulfil(order.id); }
      else if (/cancel|fail/i.test(st.status || "")) await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    } catch (err) { console.error(`[order ${order.ref}] poll error:`, err.message); }
    order = await prisma.order.findUnique({ where: { ref: req.params.ref } });
  }
  res.json(publicOrder(order));
});

app.post("/api/paynow/result", async (req, res) => {
  res.sendStatus(200);
  const { reference, status, hash: h } = req.body || {};
  const order = reference && (await prisma.order.findUnique({ where: { ref: reference } }));
  if (!order || order.status !== "PENDING") return;
  const joined = Object.entries(req.body).filter(([k]) => k !== "hash").map(([, v]) => v).join("");
  const expected = crypto.createHash("sha512").update(joined + process.env.PAYNOW_INTEGRATION_KEY).digest("hex").toUpperCase();
  if (expected !== String(h).toUpperCase()) return console.warn(`[order ${reference}] bad hash, ignored`);
  if (/^paid$/i.test(status)) { await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } }); fulfil(order.id); }
  else if (/cancel/i.test(status)) await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
});

// ================= CUSTOMER ACCOUNT / CLOSED READER =================
// Backend only for now — see docs/closed-reader-build-brief.md §9: the
// reader's visual design isn't finalized, so no reader UI is built here.
// These are the entitlement-checked APIs it will call once that UI exists.
function requireAccount(req, res, next) {
  if (req.session.accountId) return next();
  res.status(401).json({ error: "Sign in required." });
}

app.post("/api/account/login", async (req, res) => {
  const { username, password } = req.body || {};
  const account = await prisma.account.findUnique({ where: { username: String(username || "").trim().toLowerCase() } });
  if (!account || !verifyAccountPassword(password || "", account.passwordHash)) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  req.session.accountId = account.id;
  req.session.username = account.username;
  res.json({ ok: true, username: account.username });
});
app.post("/api/account/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/account/session", (req, res) => {
  res.json({ loggedIn: Boolean(req.session.accountId), username: req.session.username || null });
});

app.get("/api/library", requireAccount, async (req, res) => {
  const entitlements = await prisma.entitlement.findMany({
    where: { accountId: req.session.accountId },
    include: { product: true },
    orderBy: { grantedAt: "desc" },
  });
  const progress = await prisma.readingProgress.findMany({ where: { accountId: req.session.accountId } });
  const progressByProduct = Object.fromEntries(progress.map((p) => [p.productId, p.lastPageViewed]));
  res.json(entitlements.map((e) => ({
    productId: e.productId, title: e.product.title, cover: e.product.coverImageKey ? `/covers/${e.productId}` : null,
    pageCount: e.product.pageCount, lastPageViewed: progressByProduct[e.productId] || 1, grantedAt: e.grantedAt,
  })));
});

async function requireEntitlement(req, res, next) {
  const entitlement = await prisma.entitlement.findUnique({
    where: { accountId_productId: { accountId: req.session.accountId, productId: req.params.productId } },
  });
  if (!entitlement) return res.status(403).json({ error: "You don't own this book." });
  next();
}

app.get("/api/read/:productId/meta", requireAccount, requireEntitlement, async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
  const progress = await prisma.readingProgress.findUnique({
    where: { accountId_productId: { accountId: req.session.accountId, productId: req.params.productId } },
  });
  res.json({ title: product.title, pageCount: product.pageCount, lastPageViewed: progress ? progress.lastPageViewed : 1 });
});

// Anti-scraping page-view cap (build brief §3): a rough per-account,
// per-book, rolling-24h cap, in memory only. Deliberately simple (a first
// version, per the brief) and — because it's in memory — only correct on a
// single server instance; move it to the DB or a shared cache before
// scaling to more than one Render instance.
const pageViewLog = new Map(); // `${accountId}:${productId}:${dayKey}` -> count
function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function checkAndRecordPageView(accountId, productId, pageCount) {
  const key = `${accountId}:${productId}:${dayKey()}`;
  const count = pageViewLog.get(key) || 0;
  const cap = Math.max(20, pageCount * 2);
  if (count >= cap) return false;
  pageViewLog.set(key, count + 1);
  return true;
}

app.get("/api/read/:productId/page/:n", requireAccount, requireEntitlement, async (req, res) => {
  try {
    const pageNumber = Number(req.params.n);
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > (product.pageCount || 0)) {
      return res.status(404).json({ error: "Page not found." });
    }
    if (!checkAndRecordPageView(req.session.accountId, req.params.productId, product.pageCount)) {
      return res.status(429).json({ error: "You've hit today's reading limit for this book. Try again tomorrow." });
    }
    const page = await prisma.renderedPage.findUnique({
      where: { productId_pageNumber: { productId: req.params.productId, pageNumber } },
    });
    if (!page) return res.status(404).json({ error: "Page not found." });
    const clean = await getObjectBuffer(page.imageKey);
    const watermarked = await watermarkPageImage(clean, { username: req.session.username, date: dayKey() });
    await prisma.readingProgress.upsert({
      where: { accountId_productId: { accountId: req.session.accountId, productId: req.params.productId } },
      create: { accountId: req.session.accountId, productId: req.params.productId, lastPageViewed: pageNumber },
      update: { lastPageViewed: pageNumber },
    });
    res.set("Content-Type", "image/png").set("Cache-Control", "no-store").send(watermarked);
  } catch (err) {
    console.error(`[read ${req.params.productId} page ${req.params.n}] failed:`, err.message);
    res.status(500).json({ error: "Could not load that page." });
  }
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

// products
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  const list = await prisma.product.findMany({ orderBy: { createdAt: "desc" } });
  res.json(list.map(adminProductView));
});
app.post("/api/admin/products", requireAdmin, upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
  const { title, description, price, categoryId } = req.body;
  const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  if (!title || !(Number(price) > 0)) return res.status(400).json({ error: "Title and a price above zero are required." });
  if (!pdfFile) return res.status(400).json({ error: "Upload the PDF file." });
  try {
    // Created with a placeholder sourcePdfKey to get an id, then updated
    // once the object key (which is derived from that id) is known.
    const product = await prisma.product.create({
      data: {
        title: title.trim(), description: (description || "").trim(),
        price: Number(Number(price).toFixed(2)), categoryId: categoryId || null,
        sourcePdfKey: "pending", renderStatus: "PENDING", published: false,
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
    const updated = await prisma.product.update({ where: { id: product.id }, data: { sourcePdfKey: pdfKey, coverImageKey: coverKey } });
    // Not awaited: rendering can take a while for a long book, and the admin
    // shouldn't have to wait for it before the response comes back (brief §3).
    renderProduct(product.id, pdfFile.buffer).catch((err) => console.error(`[product ${product.id}] render kickoff failed:`, err.message));
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
  if ("published" in b) {
    const wantsPublished = b.published === "true" || b.published === true;
    if (wantsPublished && product.renderStatus !== "READY") {
      return res.status(400).json({ error: "This book isn't ready to publish yet — pages are still rendering." });
    }
    data.published = wantsPublished;
  }

  const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  try {
    if (pdfFile) {
      // A re-uploaded PDF invalidates every previously rendered page.
      await clearRenderedPages(product.id);
      await putObject(product.sourcePdfKey, pdfFile.buffer, "application/pdf");
      data.renderStatus = "PENDING";
      data.pageCount = null;
      data.published = false;
    }
    if (coverFile) {
      if (product.coverImageKey) await deleteObject(product.coverImageKey).catch(() => {});
      const ext = (coverFile.originalname.match(/\.\w+$/) || [".jpg"])[0];
      data.coverImageKey = `products/${product.id}/cover${ext}`;
      await putObject(data.coverImageKey, coverFile.buffer, coverFile.mimetype);
    }
    const updated = await prisma.product.update({ where: { id: product.id }, data });
    if (pdfFile) renderProduct(product.id, pdfFile.buffer).catch((err) => console.error(`[product ${product.id}] render kickoff failed:`, err.message));
    res.json(adminProductView(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the product." });
  }
});
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.json({ ok: true });
  // Fetch the rendered-page image keys *before* deleting the product — the
  // delete cascades and removes these DB rows, so this list would come back
  // empty if fetched afterwards, and the R2 objects would leak forever.
  const pages = await prisma.renderedPage.findMany({ where: { productId: product.id } });
  try {
    await prisma.product.delete({ where: { id: product.id } }); // RenderedPage rows cascade
  } catch (err) {
    if (err.code === "P2003") return res.status(400).json({ error: "This book has orders or entitlements on it and can't be deleted. Unpublish it instead." });
    console.error(err);
    return res.status(500).json({ error: "Could not delete the product." });
  }
  for (const page of pages) await deleteObject(page.imageKey).catch((err) => console.error(`[product ${product.id}] failed to delete ${page.imageKey}:`, err.message));
  if (product.sourcePdfKey) await deleteObject(product.sourcePdfKey).catch(() => {});
  if (product.coverImageKey) await deleteObject(product.coverImageKey).catch(() => {});
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const list = await prisma.order.findMany({ include: { product: true }, orderBy: { createdAt: "desc" } });
  res.json(list.map((o) => ({ ...publicOrder(o), productTitle: o.product.title })));
});

// upload errors as JSON
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 60 MB." : err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => console.log(`Store running on ${BASE_URL}${DEMO_MODE ? " (DEMO MODE)" : ""}`));
