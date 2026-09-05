# PDF Store (EcoCash via Paynow)

Sell PDFs online. Buyers pick a title, enter name, email and EcoCash number, approve the prompt
on their phone, and receive a copy watermarked with their details by email. You control everything
from the admin panel at `/admin`: products, covers, prices, categories, store name, and password.

The store starts completely empty. Nothing is shown until you add it.

## Files

| File | Job |
|---|---|
| `server.js` | Web server, admin API, Paynow checkout, fulfilment |
| `watermark.js` | Stamps buyer name, email, order ref and date on every page |
| `mailer.js` | Emails the PDF (uses a free test inbox until SMTP is configured) |
| `public/` | Storefront (`index.html`, `app.js`) and admin panel (`admin.html`, `admin.js`) |
| `data/` | `products.json`, `categories.json`, `settings.json` (written by the admin panel) |
| `files/` | Master PDFs uploaded through the admin panel |
| `uploads/covers/` | Cover images uploaded through the admin panel |

## Deploy on Render

1. Put this folder in a GitHub repository (GitHub Desktop is the easiest way).
2. On render.com: New → Web Service → connect the repo. Build command `npm install`,
   start command `npm start`, instance type Free.
3. Environment variables for a first test:
   ```
   DEMO_MODE=true
   SESSION_SECRET=any-long-random-text
   BASE_URL=https://<your-service-name>.onrender.com
   ```
4. Deploy, then open `https://<your-service-name>.onrender.com/admin`.
   There is no password yet, so it opens straight away. Go to **Settings → Set admin password** first.
5. Add a category (optional), then add a product: title, description, price, PDF file, cover image.
6. Open the store. Buy your product with any name/email and an EcoCash-shaped number
   (e.g. 0771234567). Demo mode fakes the payment and delivers the watermarked PDF.
   The Orders tab in admin shows a preview link to the test email.

## Go live

1. Register at paynow.co.zw → Business → Integrations → copy the Integration ID and Key.
2. In Render set `DEMO_MODE=false`, `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`.
   Paynow starts you in test mode (only the EcoCash number on your Paynow account can pay,
   no money moves). Ask Paynow to set the integration live when ready.
3. Set real email delivery (Brevo and SendGrid have free tiers):
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`.

## Important: storage on Render's free tier

Render's free instances have a temporary disk. Every deploy or restart (they restart after
15 idle minutes) wipes `data/`, `files/` and `uploads/`. That means products, categories,
covers, PDFs and the admin password you set inside the panel are lost, and orders in memory too.
Buyers who already received their email are unaffected.

This is fine for testing. Before selling for real, do one of:

- **Render persistent disk** (paid, from about US$0.25/GB/month plus a paid instance): mount it at
  `/opt/render/project/src/data`, `/files` and `/uploads` and nothing is lost.
- Move `data/` to a database (Render offers free Postgres) and files to object storage
  (Cloudflare R2 has a free tier).

Until then, set `ADMIN_PASSWORD` as an environment variable in Render as well; the panel
falls back to it if `settings.json` is wiped.

## Run locally

```
npm install
cp .env.example .env    # set DEMO_MODE=true
npm start               # http://localhost:3000 and http://localhost:3000/admin
```
