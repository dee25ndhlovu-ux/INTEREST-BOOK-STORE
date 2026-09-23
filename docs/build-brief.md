# Book Platform Build Brief — Direct Download + Creator Splits

Status: built. Supersedes `docs/closed-reader-build-brief.md` (kept for historical context, not
current). This document captures the decisions behind the current architecture so a coding agent
can pick up the work without needing the original conversation.

## 1. Why the closed reader was reverted

An earlier design (see the superseded brief) gated every purchase behind a controlled, page-by-page
reader: no raw PDF ever reached the client, pages were rasterized server-side, watermarked per
view, rate-limited against scraping. The project owner decided this traded too much buyer friction
for the piracy protection it bought, and reverted to a simpler model: a normal watermarked PDF,
downloaded directly after payment. Traceability (the watermark) was kept; the access-control layer
around it was not.

## 2. Current purchase flow

- Buyer enters **email + EcoCash number only** — no name, no account, no password.
- Payment goes through Paynow (unchanged from before — the integration itself was never the part
  that changed).
- On payment confirmation, the server watermarks the master PDF with the buyer's email, order
  reference and date, saves that specific watermarked copy to R2 keyed by the order, and the
  confirmation page shows a direct **Download your PDF** button.
- The same watermarked copy is also emailed as a **backup channel** — this must never block or
  reverse a sale. If the email send fails, the order still shows as delivered and the direct
  download still works; the failure is only logged (see `fulfil()` in `server.js`).
- The per-order download link (`/api/orders/:ref/download?token=...`) works without an account,
  so it doubles as a redownload link if the buyer loses the email or closes the tab before
  downloading. The token is a random value generated at delivery time, unrelated to the order ref.

## 3. Creator revenue splits

- Admin adds a creator with just a **name + username** (no password) from `/admin` → Creators.
- Admin assigns a creator to a product along with a **split percentage** (0-100) — the creator's
  share of that product's sale price. This is stored on the `Product` row
  (`creatorId`, `creatorSplitPct`).
- At delivery time (not at checkout, and not read live from the product later), the split is
  applied to the order's amount and frozen onto the order (`creatorEarning`, `storeEarning`).
  Changing a product's split percentage later never rewrites past orders' recorded earnings.
- Creators sign in separately at `/creator`, with their own session (`req.session.creatorId`,
  distinct from the admin session). **First login sets the password**: admin never sets or knows
  a creator's password — the first successful login with a known username, given any password of
  at least 6 characters, sets that as the password from then on (see `POST /api/creator/login`).
- A creator's portal shows only their own products and earnings — never other creators', never the
  full admin order list.

## 4. Admin revenue meter

- `/admin` shows a running total of revenue from orders this store's own database has marked
  `DELIVERED` (`GET /api/admin/summary`).
- **This is not a live bank/EcoCash feed.** There is no API connection to the real account balance
  — it only reflects what this app itself recorded. The UI must keep saying so; don't let this
  meter's label drift into implying real-time bank reconciliation.

## 5. Visual direction

- Storefront (`index.html`/`app.js`/`style.css`): simple iTunes/App-Store-like look — white
  background, black text and accents only (no color accents), system font stack, a large square
  cover-art grid, no category filter chips. Implemented as a `body.store` CSS-variable override
  block in `style.css` so the shared admin/creator dark theme is untouched.
- Admin (`/admin`) and creator portal (`/creator`) keep the original dark admin theme — the
  redesign request was specifically about the customer-facing store, not the back office.

## 6. What was removed

Deleted or trimmed as no longer applicable once the closed reader was reverted:

- `render.js` (upload-time PDF → page-image rendering via `pdftoppm`) — deleted entirely.
- `Dockerfile` — deleted; Render deploy is back to a plain Node web service, since nothing shells
  out to `poppler-utils` anymore.
- `watermark.js`'s `watermarkPageImage` — deleted; only whole-document `watermarkPdf` remains,
  now keyed on email instead of name (no name is collected at checkout).
- Prisma models `Account` (buyer accounts/login), `RenderedPage`, `Entitlement`, `ReadingProgress`,
  and the `RenderStatus` enum — dropped in migration
  `prisma/migrations/20260923233455_pivot_to_direct_download_and_creators`. There was no real
  order data at the time, so this was a clean drop, not a data migration.
- `sharp` dependency — was only used by the deleted page-image watermarking path.
- Reader-only API routes (`/api/account/*`, `/api/library`, `/api/read/:productId/...`) and their
  in-memory anti-scraping page-view cap.

## 7. What was kept unchanged

- Paynow integration (checkout, polling, webhook + hash verification) — untouched.
- Cloudflare R2 for object storage (master PDFs, covers, and now per-order watermarked PDFs too,
  for the redownload link) — untouched in mechanism, just a new usage (see §2).
- Postgres via Prisma, admin password scheme, `data/settings.json` for store name/tagline (still
  the one known local-disk gap — see README "Known gaps").
