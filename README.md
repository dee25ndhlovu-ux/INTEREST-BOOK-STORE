# Book Platform — closed reader + EcoCash store

Sell PDFs online. Buyers pick a title, enter name/email/EcoCash number and choose a
username + password (this becomes their account), approve the payment prompt on their phone, and
get a copy emailed to them, watermarked with their details. You control everything from the admin
panel at `/admin`: products, covers, prices, categories, store name, and password.

The store starts completely empty. Nothing is shown until you add it.

This is mid-migration to the architecture in `docs/closed-reader-build-brief.md`: a real database
(Postgres via Prisma) and object storage (Cloudflare R2) instead of JSON files and an in-memory
order list, plus the groundwork for a closed reader (books are rendered to page images at upload
time and only ever served watermarked, per view — brief §2–§3). **What exists today:** the
database-backed store/checkout/admin flow below, and the reader's backend APIs
(`/api/account/*`, `/api/library`, `/api/read/:productId/...`). **What does not exist yet:** the
reader's own UI — the visual design in brief §9 is still open, so no frontend was built against
those APIs. The apps in brief §4 (Android/iOS/Windows) are unstarted.

## Files

| File | Job |
|---|---|
| `server.js` | Web server, admin API, checkout, Paynow, fulfilment, reader APIs |
| `db.js` | Prisma client (Postgres) |
| `prisma/schema.prisma` | Database schema — accounts, products, orders, entitlements, etc. |
| `storage.js` | Cloudflare R2 client — master PDFs, covers, rendered page images |
| `render.js` | Upload-time PDF → page-image rendering (shells out to `pdftoppm`) |
| `watermark.js` | Watermarks the emailed PDF, and per-page images for the reader |
| `mailer.js` | Emails the PDF (uses a free test inbox until SMTP is configured) |
| `public/` | Storefront (`index.html`, `app.js`) and admin panel (`admin.html`, `admin.js`) |
| `data/settings.json` | Store name, tagline, admin password — see "Known gap" below |
| `Dockerfile` | Needed on Render so `pdftoppm` (poppler-utils) is actually available |

## Deploy on Render

This now needs three things beyond the old setup: a **Postgres database**, an **R2 bucket**, and
the **Docker** environment (for poppler-utils — see Dockerfile).

1. Put this folder in a GitHub repository.
2. Create a Postgres database (Render's own is fine — **do not use the free tier**, it's deleted
   after ~44 days; use the smallest paid plan, a few dollars/month). Copy its connection string.
3. Create a Cloudflare R2 bucket and an API token (R2 → Manage API Tokens). Note the account ID,
   access key ID, secret access key, and bucket name.
4. On render.com: New → Web Service → connect the repo. Render should detect the `Dockerfile`
   automatically (if it offers a runtime choice, pick Docker, not "Node"). No build/start command
   needed — the Dockerfile's `CMD` covers it.
5. Environment variables:
   ```
   DEMO_MODE=true
   SESSION_SECRET=any-long-random-text
   BASE_URL=https://<your-service-name>.onrender.com
   DATABASE_URL=<the Postgres connection string from step 2>
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=...
   ```
6. Run the schema against your new database once, from any machine with normal internet access
   (this sandbox's network policy blocks the Prisma engine download, so it couldn't be done from
   here): `DATABASE_URL=... npx prisma migrate deploy`.
7. Deploy, then open `https://<your-service-name>.onrender.com/admin` and set an admin password
   (Settings → Set admin password) — do this immediately, since there's no password until you do.
8. Add a category (optional), then add a product: title, description, price, PDF, cover. The
   "Rendering" column in the product list shows Processing… until every page is rasterized; a book
   can't be published until it says Ready.
9. Open the store, buy the product with any name/email/EcoCash-shaped number and a new
   username/password. Demo mode fakes the payment and delivers the watermarked PDF; the Orders tab
   shows a preview link to the test email.

## Go live

1. Register at paynow.co.zw → Business → Integrations → copy the Integration ID and Key.
2. In Render set `DEMO_MODE=false`, `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`.
   Paynow starts you in test mode (only the EcoCash number on your Paynow account can pay,
   no money moves). Ask Paynow to set the integration live when ready.
3. Set real email delivery (Brevo and SendGrid have free tiers):
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`.

## Known gaps (not fixed in this pass — flagging rather than guessing)

- **`data/settings.json`** (store name, tagline, admin password) is still local disk, so it's
  still wiped on every restart/redeploy exactly like the old `products.json` used to be. It isn't
  in `prisma/schema.prisma` — the build brief never specified a Settings table, so one wasn't
  invented here. Until it's added, keep `ADMIN_PASSWORD` set as an env var (the panel falls back
  to it if the file is wiped).
- **The anti-scraping page-view cap** (brief §3) is a simple in-memory counter per
  account+book+day. It resets on restart and — because it's in memory — only actually works
  correctly on a single server instance. Fine for one Render instance; would need to move to the
  database or a shared cache before running more than one.
- **Live Paynow credentials and the exact offline-caching policy** are the two items the brief
  itself (§10, §5) left open pending the project owner — still open, not addressed here.

## Run locally

```
npm install               # also runs `prisma generate`
cp .env.example .env      # set DEMO_MODE=true, DATABASE_URL, R2_* (a local Postgres is fine)
npx prisma migrate deploy # creates the tables
npm start                 # http://localhost:3000 and http://localhost:3000/admin
```
