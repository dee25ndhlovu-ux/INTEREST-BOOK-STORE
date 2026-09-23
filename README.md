# Book Platform — direct-download EcoCash store

Sell PDFs online. Buyers pick a title, enter their email and EcoCash number, approve the payment
prompt on their phone, and get a watermarked copy as an instant download right on the confirmation
page (email is a backup delivery channel, not the primary one). Creators can be assigned to a
product with a revenue-split percentage, and sign in separately at `/creator` to see their own
products and earnings. You control everything else from the admin panel at `/admin`: products,
covers, prices, categories, creators, store name, and password.

The store starts completely empty. Nothing is shown until you add it.

This replaced an earlier closed-reader design (page-by-page rendering, in-app watermarked viewing,
buyer accounts) — see `docs/build-brief.md` for why, and for the architecture below.

## Files

| File | Job |
|---|---|
| `server.js` | Web server, admin API, creator API, checkout, Paynow, fulfilment |
| `db.js` | Prisma client (Postgres) |
| `prisma/schema.prisma` | Database schema — products, orders, creators, categories |
| `storage.js` | Cloudflare R2 client — master PDFs, covers, per-order watermarked PDFs |
| `watermark.js` | Stamps buyer email, order ref and date onto the delivered PDF |
| `mailer.js` | Emails a backup copy of the PDF (uses a free test inbox until SMTP is configured) |
| `public/` | Storefront (`index.html`, `app.js`), admin panel (`admin.html`, `admin.js`), creator portal (`creator.html`, `creator.js`) |
| `data/settings.json` | Store name, tagline, admin password — see "Known gap" below |

## Deploy on Render

A plain Node web service is enough — no Docker/system packages needed (there's no server-side PDF
page rendering, so nothing here shells out to external binaries).

1. Put this folder in a GitHub repository.
2. Create a Postgres database (Render's own is fine — **do not use the free tier for real data**,
   it's deleted after ~44 days; use the smallest paid plan, a few dollars/month, before accepting
   real orders). Copy its connection string.
3. Create a Cloudflare R2 bucket and an API token (R2 → Manage API Tokens). Note the account ID,
   access key ID, secret access key, and bucket name.
4. On render.com: New → Web Service → connect the repo. Build command `npm install`, start command
   `npm start`.
5. Environment variables:
   ```
   DEMO_MODE=true
   SESSION_SECRET=any-long-random-text
   BASE_URL=https://<your-service-name>.onrender.com
   DATABASE_URL=<the Postgres connection string from step 2>?sslmode=require
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=...
   ```
6. Run the schema against your new database once, from a machine with normal internet access:
   `DATABASE_URL=... npx prisma migrate deploy`. If the database has an IP allowlist, add that
   machine's public IP under its Networking settings first, or the connection will be refused.
7. Deploy, then open `https://<your-service-name>.onrender.com/admin` and set an admin password
   (Settings → Set admin password) — do this immediately, since there's no password until you do.
8. Add a category (optional) and a creator (optional), then add a product: title, description,
   price, PDF, cover, and optionally a creator + their split %.
9. Open the store, buy the product with any email and an EcoCash-shaped number. Demo mode fakes
   the payment and unlocks the download immediately; the Orders tab shows a preview link to the
   test email (the backup copy).

## Go live

1. Register at paynow.co.zw → Business → Integrations → copy the Integration ID and Key.
2. In Render set `DEMO_MODE=false`, `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`.
   Paynow starts you in test mode (only the EcoCash number on your Paynow account can pay,
   no money moves). Ask Paynow to set the integration live when ready.
3. Set real email delivery (Brevo and SendGrid have free tiers):
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`. Not required for the sale to
   work — only for the backup email to actually send — but worth setting up.

## Known gaps (not fixed in this pass — flagging rather than guessing)

- **`data/settings.json`** (store name, tagline, admin password) is still local disk, so it's
  still wiped on every restart/redeploy exactly like the old `products.json` used to be. Until
  it's moved into Postgres, keep `ADMIN_PASSWORD` set as an env var (the panel falls back to it if
  the file is wiped).
- **The admin revenue meter** reflects only this store's own recorded orders — there is no API
  connection to a real bank/EcoCash balance, and the UI says so.
- **Live Paynow credentials** — the integration code is complete; going live needs only the two
  env vars in step 2 above, once you have them from Paynow.

## Run locally

```
npm install               # also runs `prisma generate`
cp .env.example .env      # set DEMO_MODE=true, DATABASE_URL, R2_* (a local Postgres is fine)
npx prisma migrate deploy # creates the tables
npm start                 # http://localhost:3000, /admin and /creator
```
