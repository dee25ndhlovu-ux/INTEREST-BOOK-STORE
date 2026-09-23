> **Superseded.** The closed-reader model described in this document was built, then reverted —
> the project owner decided it added too much buyer friction for the piracy protection it bought.
> Current architecture: direct watermarked-PDF download, no buyer accounts, creator revenue splits.
> See `docs/build-brief.md`. This file is kept for historical context only — do not build against
> it.

# Book Platform Build Brief — Closed Reader + EcoCash Store (superseded)

Status: architecture discussion, not yet built. This document captures decisions made in planning so far, so a coding agent (this tool continued, or Claude Code against the live repository) can pick up the work without needing the original conversation. Sections marked "Open" are not yet decided and should be confirmed with the project owner before an agent invents an answer.

## 1. Starting point

There is a live store already: admin panel, Paynow/EcoCash checkout, categories and pricing, deployed on Render as "Interest Book Store" (Node backend, GitHub repo `dee25ndhlovu-ux/INTEREST-BOOK-STORE`). It currently delivers purchases as raw downloadable PDFs, with no accounts and no real database. Specifically, as it exists today:

- **Products** are a flat JSON file (`products.json`), each entry: `id, title, description, price, categoryId, file (PDF filename), cover (image path), published, createdAt`. No database, just an array read and written directly to disk.
- **Categories** are the same pattern, a separate `categories.json`, just `id, name`.
- **Orders/sales live only in server memory** (a JS `Map`), created at checkout, updated when Paynow confirms payment, marked delivered once the watermarked PDF is emailed. Wiped completely on every server restart. There is no persistent sales record at all right now.
- **Payment confirmation** happens two ways: the browser polls an endpoint that checks Paynow's status via their API, and Paynow separately can POST a result callback to a webhook, which verifies a hash signature before marking the order paid and triggering delivery (watermark + email via Brevo).
- **No accounts or login exist for customers.** A purchase is fully anonymous: name, email, and EcoCash number entered at checkout, no persistent identity across purchases. The only existing "login" is a single admin password (or none) protecting the admin panel, unrelated to customers.
- **No meaningful existing customer base to preserve.** Only a handful of transactions so far, mostly demo/testing. Confirmed: this is a clean relaunch, nothing to migrate or grandfather from the current arrangement.

This project replaces the delivery layer with a closed, account-bound reader, and replaces the JSON-files-plus-in-memory-Map persistence with a real database (§8). The admin panel, checkout flow, and store structure are the foundation to build on, not to discard.

**Confirmed against the actual repository** (`dee25ndhlovu-ux/INTEREST-BOOK-STORE`, cloned and read directly): everything above matches the real code exactly. Two things worth adding:

- **The Paynow integration is already fully built, not a stub.** Checkout, sending the EcoCash prompt (`paynow.sendMobile`), polling (`pollTransaction`), and the webhook handler with hash verification are all real, working code in `server.js`. Going live needs nothing but the two environment variables, `PAYNOW_INTEGRATION_ID` and `PAYNOW_INTEGRATION_KEY`, no further coding work.
- **The project's own README already documents the ephemeral-disk problem**: Render's free tier wipes `data/`, `files/`, and `uploads/` on every restart or redeploy, and suggests exactly the fix this brief calls for, moving structured data to Postgres and files to object storage (see §8).

## 2. Core principle

Content is never sent to a client as a document. No PDF bytes, no extractable text layer, no vector data a script could reassemble. The server renders each page to a flat raster image (a picture, not a document object) and sends only that. Ownership lives permanently on the buyer's account, server-side; anything on a device is a disposable, replaceable cache.

## 3. Closed reader architecture

**Rendering.** Each page of a purchased book is rendered to a raster image once, at upload time in the admin panel, not on first read. The book is not made available for purchase until every page has finished rendering, which removes any window where many simultaneous readers could each trigger a redundant render of the same uncached page (a thundering-herd problem that on-demand rendering would otherwise create). Recommended tool: Poppler's `pdftoppm`, shelled out to from the Node backend — mature, fast, free.

**Watermarking.** The clean, unwatermarked render from the step above is cached server-side and never leaves the server. On every page view, the watermark (buyer identity) is composited onto that cached image fresh, per request, per viewer. This keeps the expensive step (rendering) to once per page ever, while keeping the cheap step (watermark burn-in) unique to every view, so every copy that reaches a screen is traceable to one buyer.

**Transmission.** The client only ever receives the specific page(s) currently being viewed, fetched per request, authenticated against the account each time. No preloading the whole book. The one deliberate exception: to support a smooth page-turn transition (see §6), the app may prefetch one page ahead of the one currently displayed. This is a bounded, still-authenticated exception, not a bulk transfer, and does not weaken the model.

**Anti-scraping.** A simple page-view cap per account per book (e.g., cannot view materially more total pages than the book contains, more than once or twice in a rolling day) is the recommended first-version defence against systematic scraping. Timing/pattern-based anomaly detection was considered and deliberately deferred — it's a soft deterrent easily evaded with jitter, and risks false positives against genuine fast readers; build it only if real abuse is observed.

**Resolution.** Render at roughly 2x mobile viewport resolution — sharp enough to read and mildly zoom, not print quality. A "tap to zoom into a region requests a higher-res crop" refinement was discussed but is not needed for v1.

**Known trade-off, accepted deliberately.** Rasterizing kills native text selection, copy, in-book search, and screen-reader accessibility. This is a stricter posture than Kindle's actual DRM (which keeps a real, encrypted text layer client-side). Accepted as the right trade for this platform's piracy risk. If in-book search becomes a priority later, the fix is a server-side-only OCR text layer that answers search queries with page numbers, never with raw text.

## 4. Platform strategy for the reader

**Android.** Native app, distributed as a downloadable APK from the platform's own website, not the Play Store. Avoids Google's in-app purchase cut entirely (EcoCash/Paynow remains the payment method). Gets the fullest offline experience of any platform, since the app controls its own storage and can cache watermarked page images securely. Friction: users must accept an "install from unknown sources" prompt; needs clear onboarding copy.

**iOS.** No sideloading is possible on iOS for a general audience; distribute as a web app (PWA) accessed by link, not through the App Store. Prompt users to "Add to Home Screen," which moves the app out of Safari's aggressive ~7-day storage eviction for ordinary tabs into better-persisted "installed" status. Not a guarantee against eviction under device storage pressure — backstopped by the fact that ownership lives on the account, so anything evicted is just re-fetched.

*Open:* Apple's "Reader app" exception (following the Epic v. Apple ruling) may allow a real native-ish iOS app on the App Store with purchases still routed to an external website, avoiding Apple's cut — this has been loosening through 2025–2026 but varies by region and is a moving target. Worth a fresh check when the iOS build is actually scheduled, rather than assuming PWA is the permanent ceiling.

**Windows/Desktop.** Web app (PWA), same as iOS, for now. There's no store-commission pressure forcing this choice the way there is for Android/iOS, so the reasoning is different: desktop is the easiest environment for stripping or screenshotting content, so it should not be given more offline access than iOS gets. A native wrapper can be added later purely as UI polish, not as a route to more offline capability.

**Universal note.** Screenshotting is possible on any platform regardless of app type (the "analog hole"). The in-content watermark is the backstop everywhere; it is not a Windows-specific gap.

## 5. Offline reading of purchased content

Net shape: only already-rendered, already-watermarked page images are ever safe to cache locally, because that's the only thing that ever legitimately exists on a client at all — there's no raw document to accidentally leak. Android gets the richest offline caching. iOS and Windows get whatever the PWA storage model allows, improved by "Add to Home Screen," not guaranteed permanent, always recoverable from the account.

*Open:* exact offline policy details — how many pages ahead/behind get cached, whether there's an explicit "download this book for offline" action versus only caching what's been viewed, and how long a cached page stays valid before requiring re-verification against the account.

## 6. Reader UX

**Page transitions:** a clean slide between pages, decided for now — not a page-curl/flip effect. Reasoning: a convincing curl effect requires rapid, repeated redraws (~60 times/second) with shading and 3D transforms, which costs real battery and can visibly stutter on older or cheaper phones, especially inside a browser (iOS/Windows) rather than native code (Android). A clean slide is cheap, reliable, and looks fine everywhere. Revisit a fancier animation later as a polish pass if desired.

**Prefetching:** because even a slide transition benefits from the next page already being in hand, prefetch one page ahead of the one being displayed (see §3, Transmission).

## 7. Local file library (reading the user's own files, not purchased)

Separate and materially simpler than the closed reader, because there is no piracy risk to manage — it's the user's own file. Decision made: build this as a full managed library (organize, categorize, and track reading progress on files the user already owns), not just a one-off "open and view" picker.

**Android:** can watch a folder and keep the library automatically up to date via real file-system access — closest to full library-management behaviour.

**iOS:** browsers cannot freely scan device storage; only files a user explicitly picks are accessible. The workable equivalent of "manage a library" here is import-on-add: when a user adds a file, its content is copied into the app's own storage there and then, and from that point it behaves as a full library entry (progress tracking, categorization) exactly like Android's. Safari's storage-eviction behaviour (§5) applies to this copy too — lower stakes than for purchased content, since the user still has their original file regardless.

**Windows:** same import-on-add approach as iOS is the safe baseline. Because Windows PWA use will typically go through a Chromium-based browser (Chrome/Edge) rather than Safari's engine, the File System Access API may allow requesting persistent access to a folder once and keeping a standing reference — closer to Android's automatic behaviour — without needing Safari's cooperation. Worth prototyping as an enhancement once the baseline import-on-add version works.

**Decided:** local-library reading progress stays on-device only for v1 and does not sync across devices through the server — it was never the platform's content to track centrally, and syncing it adds server complexity for a convenience feature.

## 8. Database schema and accounts

The current JSON-files-and-in-memory-Map setup (§1) is replaced with a real relational database. Recommended: Render's own managed PostgreSQL, since it's a first-party service on the same platform already hosting the app, kept in the same region for a fast internal connection. **Do not use Render's free Postgres tier for this** — it expires 30 days after creation, gives a 14-day grace period, then deletes the database and all its data, which is not acceptable for real customer purchase records. Start on the smallest paid tier (roughly $6–7/month). Recommended library on the Node side: Prisma, for type-safe queries and managed migrations rather than hand-written SQL.

Since there is no existing customer base or account data (§1), this is a clean schema design, not a migration of real records. `products.json` and `categories.json` can still be loaded once via a simple one-off script to seed the new tables, since that data is worth keeping even though no accounts or orders need preserving.

**File storage, separate from the database.** Postgres holds structured rows, it is not where the master PDFs, cover images, or the closed reader's rendered page images should physically live, and the project's own README already flags that Render's free-tier disk is wiped on every restart, meaning any of these files currently sitting in `files/` or `uploads/covers/` do not actually survive reliably today. The fix is object storage: Cloudflare R2 is the sensible default, S3-compatible, has a free tier to start on, and pairs naturally with a Postgres database holding everything else. Concretely, the master PDF a product was created from, the cover image, and every row in `rendered_pages` should each store a reference (an object key/URL) pointing into R2 rather than a local filesystem path.

**accounts** — id, username (unique, chosen by the buyer, not required to be an email), password_hash, recovery_email (captured at signup, plays no role in day-to-day login), created_at.

**categories** — id, name. Seeded directly from `categories.json`.

**products** — id, title, description, price, category_id (FK), a private server-side-only reference to the original source PDF, cover_image_path, published (bool), page_count, render_status (pending while pages are being rasterized at upload, ready once every page has a cached image — the storefront only lists a book as buyable once render_status is ready), created_at. Seeded from `products.json`, with render_status backfilled by running each existing PDF through the new rendering step.

**rendered_pages** — id, product_id (FK), page_number, image_reference (the clean, unwatermarked cached render — see §3). One row per page per book.

**orders** — id, product_id (FK), account_id (FK), paynow_reference, ecocash_number, amount, status (pending / paid / delivered / failed), created_at, paid_at, delivered_at. Replaces the in-memory Map entirely; the existing polling-and-webhook Paynow confirmation flow (§1) now writes to this table instead of memory.

**entitlements** — account_id (FK), product_id (FK), granted_at. A simple derived table recording what an account actually owns, written once an order reaches paid status. Kept separate from orders so the reader app can check "does this account own this book" without reasoning through payment-status logic on every check.

**reading_progress** — account_id (FK), product_id (FK), last_page_viewed, updated_at.

**Authentication and recovery — decided.** Accounts are created with a self-chosen username and password as part of checkout (not auto-created from an email afterwards), so every purchase is directly and unambiguously tied to an account from the moment of payment. A recovery_email is captured at signup but is not used for login. If someone is locked out, recovery is manual for now: they contact the store, an admin verifies them against their order (matched via the EcoCash number or Paynow reference already on the order record, or the recovery email), and manually resets the password via the admin panel. The recovery_email is captured now specifically so this could become an automated reset-link flow later without needing to go back and collect it retroactively — and since Brevo is already integrated for delivery emails, no new email infrastructure would be needed to switch that on.

## 9. Interface direction (design discussion started, not finalized)

Five screens identified: home/library (purchased + local books together), store/browse (discovery and purchase), the reader itself, checkout (EcoCash/Paynow), and account.

Direction agreed: clean, flat, tech-like visual language — solid colour blocks or thin borders rather than drop shadows to indicate interactivity, generous white space, one confident accent colour rather than many button colours, a serious sans-serif typeface suited to legal/academic content rather than anything playful. Consistent with existing brand direction for this store: Shopify-like cleanliness, blue/white/black, no "AI-looking" shadowed buttons. Empty states must be honest (no fake placeholder books/categories) — matches an existing standing rule for the admin/store side.

*Open, not yet decided:*
- Light or dark as the primary shell feel (the reader screen itself may reasonably use a warm "paper" tone regardless of the shell's theme).
- Whether purchased books and locally-added files should look visually distinct on the library/home screen, or sit together as one indistinguishable shelf.
- The specific design of the store's empty state when the catalogue is small or just starting out.

## 10. Open items not yet addressed at all

- **Live Paynow credentials.** The integration code itself is complete (§1); what's missing is purely the business step of obtaining a live `PAYNOW_INTEGRATION_ID` and `PAYNOW_INTEGRATION_KEY` from Paynow. Status not yet confirmed — need to establish whether these are already issued, pending, or not yet applied for.
- **Exact offline caching policy** for purchased content (§5).

**Resolved:** repository access. The repo (`dee25ndhlovu-ux/INTEREST-BOOK-STORE`) is public and has been cloned and read directly; building can proceed against the real code.

## 11. What NOT to assume

An agent picking this up should not invent answers to any item marked *Open* above. Confirm with the project owner first, the same way this document was built through discussion rather than assumption.
