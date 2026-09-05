require("dotenv").config();
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Paynow } = require("paynow");
const { watermarkPdf } = require("./watermark");
const { sendPdf } = require("./mailer");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DATA = path.join(__dirname, "data");
const FILES_DIR = path.join(__dirname, "files");
const COVERS_DIR = path.join(__dirname, "uploads", "covers");
for (const d of [DATA, FILES_DIR, COVERS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- tiny JSON store ----------
const db = {
  read(name, fallback) {
    const p = path.join(DATA, `${name}.json`);
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
  },
  write(name, value) {
    fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(value, null, 2));
  },
};
const products = () => db.read("products", []);
const categories = () => db.read("categories", []);
const settings = () => db.read("settings", {});

// ---------- password: settings.json first, env var as fallback ----------
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
app.use("/covers", express.static(COVERS_DIR, { maxAge: "7d" }));

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === "pdf" ? FILES_DIR : COVERS_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
      cb(null, `${Date.now().toString(36)}-${safe}`);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "pdf") return cb(null, file.mimetype === "application/pdf");
    return cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype));
  },
});

// ---------- orders (in memory) ----------
const orders = new Map();

function makePaynow() {
  const pn = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
  pn.resultUrl = `${BASE_URL}/api/paynow/result`;
  pn.returnUrl = `${BASE_URL}/`;
  return pn;
}

async function fulfil(order) {
  if (order.status === "delivered" || order.fulfilling) return;
  order.fulfilling = true;
  try {
    const product = products().find((p) => p.id === order.productId);
    if (!product) throw new Error("Product no longer exists");
    const pdf = await watermarkPdf(path.join(FILES_DIR, product.file), {
      name: order.name, email: order.email, orderRef: order.ref, date: new Date().toISOString().slice(0, 10),
    });
    const result = await sendPdf({
      to: order.email, name: order.name, productTitle: product.title, orderRef: order.ref,
      pdfBuffer: pdf, fileName: `${product.title.replace(/[^a-z0-9]+/gi, "-")}.pdf`,
      storeName: settings().storeName || "PDF Store",
    });
    order.status = "delivered";
    order.deliveredAt = new Date().toISOString();
    order.emailPreview = result.preview;
    console.log(`[order ${order.ref}] delivered to ${order.email}`);
  } catch (err) {
    order.status = "delivery_failed";
    order.error = err.message;
    console.error(`[order ${order.ref}] delivery failed:`, err.message);
  } finally {
    order.fulfilling = false;
  }
}

const publicProduct = ({ file, ...p }) => p;
const publicOrder = ({ pollUrl, fulfilling, ...o }) => o;

// ================= PUBLIC =================
app.get("/api/store", (req, res) => {
  const s = settings();
  res.json({
    storeName: s.storeName || "PDF Store",
    tagline: s.tagline || "",
    categories: categories(),
    products: products().filter((p) => p.published !== false).map(publicProduct),
  });
});

app.post("/api/checkout", async (req, res) => {
  const { productId, name, email, phone } = req.body || {};
  const product = products().find((p) => p.id === productId && p.published !== false);
  if (!product) return res.status(400).json({ error: "Product not found." });
  if (!name || !email || !phone) return res.status(400).json({ error: "Name, email and EcoCash number are required." });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const cleanPhone = String(phone).replace(/\s/g, "");
  if (!/^0(77|78)\d{7}$/.test(cleanPhone)) return res.status(400).json({ error: "Enter a valid EcoCash number, e.g. 0771234567." });

  const ref = "ORD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const order = {
    ref, productId, productTitle: product.title, name: name.trim(), email: email.trim().toLowerCase(),
    phone: cleanPhone, amount: product.price, status: "pending", createdAt: new Date().toISOString(), pollUrl: null,
  };
  orders.set(ref, order);

  if (DEMO_MODE) {
    order.status = "paid";
    fulfil(order);
    return res.json({ ref, instructions: "Demo mode: payment simulated. Delivering your PDF now." });
  }
  try {
    const paynow = makePaynow();
    const payment = paynow.createPayment(ref, order.email);
    payment.add(product.title, product.price);
    const r = await paynow.sendMobile(payment, order.phone, "ecocash");
    if (!r || !r.success) {
      order.status = "failed";
      order.error = (r && r.error) || "Paynow rejected the request";
      return res.status(502).json({ error: `Payment could not be started: ${order.error}` });
    }
    order.pollUrl = r.pollUrl;
    res.json({ ref, instructions: r.instructions || "Check your phone and enter your EcoCash PIN to approve." });
  } catch (err) {
    order.status = "failed";
    order.error = err.message;
    res.status(502).json({ error: `Payment could not be started: ${err.message}` });
  }
});

app.get("/api/orders/:ref", async (req, res) => {
  const order = orders.get(req.params.ref);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status === "pending" && order.pollUrl) {
    try {
      const st = await makePaynow().pollTransaction(order.pollUrl);
      if (st.paid()) { order.status = "paid"; fulfil(order); }
      else if (/cancel|fail/i.test(st.status || "")) order.status = "cancelled";
    } catch (err) { console.error(`[order ${order.ref}] poll error:`, err.message); }
  }
  res.json(publicOrder(order));
});

app.post("/api/paynow/result", (req, res) => {
  res.sendStatus(200);
  const { reference, status, hash: h } = req.body || {};
  const order = reference && orders.get(reference);
  if (!order || order.status !== "pending") return;
  const joined = Object.entries(req.body).filter(([k]) => k !== "hash").map(([, v]) => v).join("");
  const expected = crypto.createHash("sha512").update(joined + process.env.PAYNOW_INTEGRATION_KEY).digest("hex").toUpperCase();
  if (expected !== String(h).toUpperCase()) return console.warn(`[order ${reference}] bad hash, ignored`);
  if (/^paid$/i.test(status)) { order.status = "paid"; fulfil(order); }
  else if (/cancel/i.test(status)) order.status = "cancelled";
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
app.get("/api/admin/categories", requireAdmin, (req, res) => res.json(categories()));
app.post("/api/admin/categories", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Category name is required." });
  const list = categories();
  if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "That category already exists." });
  const cat = { id: crypto.randomBytes(3).toString("hex"), name };
  list.push(cat);
  db.write("categories", list);
  res.json(cat);
});
app.delete("/api/admin/categories/:id", requireAdmin, (req, res) => {
  db.write("categories", categories().filter((c) => c.id !== req.params.id));
  db.write("products", products().map((p) => (p.categoryId === req.params.id ? { ...p, categoryId: null } : p)));
  res.json({ ok: true });
});

// products
app.get("/api/admin/products", requireAdmin, (req, res) => res.json(products()));
app.post("/api/admin/products", requireAdmin, upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]), (req, res) => {
  const { title, description, price, categoryId } = req.body;
  const pdf = req.files && req.files.pdf && req.files.pdf[0];
  const cover = req.files && req.files.cover && req.files.cover[0];
  if (!title || !(Number(price) > 0)) return res.status(400).json({ error: "Title and a price above zero are required." });
  if (!pdf) return res.status(400).json({ error: "Upload the PDF file." });
  const list = products();
  const product = {
    id: crypto.randomBytes(4).toString("hex"),
    title: title.trim(), description: (description || "").trim(), price: Number(Number(price).toFixed(2)),
    categoryId: categoryId || null, file: pdf.filename, cover: cover ? `/covers/${cover.filename}` : null,
    published: true, createdAt: new Date().toISOString(),
  };
  list.push(product);
  db.write("products", list);
  res.json(product);
});
app.put("/api/admin/products/:id", requireAdmin, upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]), (req, res) => {
  const list = products();
  const p = list.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const b = req.body;
  if (b.title) p.title = b.title.trim();
  if (typeof b.description === "string") p.description = b.description.trim();
  if (b.price && Number(b.price) > 0) p.price = Number(Number(b.price).toFixed(2));
  if ("categoryId" in b) p.categoryId = b.categoryId || null;
  if ("published" in b) p.published = b.published === "true" || b.published === true;
  if (req.files && req.files.pdf) p.file = req.files.pdf[0].filename;
  if (req.files && req.files.cover) p.cover = `/covers/${req.files.cover[0].filename}`;
  db.write("products", list);
  res.json(p);
});
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  db.write("products", products().filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => res.json([...orders.values()].map(publicOrder).reverse()));

// upload errors as JSON
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 60 MB." : err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => console.log(`Store running on ${BASE_URL}${DEMO_MODE ? " (DEMO MODE)" : ""}`));
