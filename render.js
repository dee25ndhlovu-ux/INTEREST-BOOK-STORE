// Upload-time page rendering for the closed reader (build brief §3).
//
// Each page of a purchased book is rasterized to a PNG exactly once, right
// after the admin uploads the PDF — never on demand when a reader opens a
// page. The clean (unwatermarked) render is cached in R2; server.js composes
// the buyer's watermark on top of a fresh copy of that cache on every page
// view (see watermark.js `watermarkPageImage`).
//
// Shells out to Poppler's `pdftoppm`, which must be present on PATH. On
// Render's default Node runtime it is NOT installed — this only works if the
// service is deployed from the repo's Dockerfile (see Dockerfile /
// README "Deploy on Render"), which apt-installs poppler-utils.

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);

const { prisma } = require("./db");
const { putObject, deleteObject } = require("./storage");

// ~2x mobile viewport resolution per build brief §3 ("Resolution"): sharp
// enough to read and mildly zoom, not print quality.
const RENDER_DPI = 150;

// Renders every page of `pdfBuffer` and uploads each as
// `products/<productId>/pages/<n>.png`, then writes one RenderedPage row per
// page and flips the product to READY (or FAILED on any error). Runs after
// the HTTP response for the upload has already gone out — server.js does not
// await this — so a slow/huge PDF doesn't block the admin request.
async function renderProduct(productId, pdfBuffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `render-${productId}-`));
  const inputPath = path.join(tmpDir, "source.pdf");
  const outPrefix = path.join(tmpDir, "page");

  try {
    await prisma.product.update({
      where: { id: productId },
      data: { renderStatus: "PROCESSING" },
    });

    await fs.writeFile(inputPath, pdfBuffer);

    // -png: raster output. -r: DPI. Produces page-1.png, page-2.png, ...
    // (pdftoppm pads the number only when the doc has >9 pages, so we can't
    // assume a fixed width — list the directory instead of guessing names.)
    await execFileAsync("pdftoppm", ["-png", "-r", String(RENDER_DPI), inputPath, outPrefix]);

    const files = (await fs.readdir(tmpDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .map((f) => ({ f, n: Number(f.slice("page-".length, -".png".length)) }))
      .filter((x) => Number.isInteger(x.n))
      .sort((a, b) => a.n - b.n);

    if (files.length === 0) throw new Error("pdftoppm produced no pages");

    for (const { f, n } of files) {
      const buf = await fs.readFile(path.join(tmpDir, f));
      const imageKey = `products/${productId}/pages/${n}.png`;
      await putObject(imageKey, buf, "image/png");
      await prisma.renderedPage.upsert({
        where: { productId_pageNumber: { productId, pageNumber: n } },
        create: { productId, pageNumber: n, imageKey },
        update: { imageKey },
      });
    }

    await prisma.product.update({
      where: { id: productId },
      data: { renderStatus: "READY", pageCount: files.length },
    });
  } catch (err) {
    console.error(`[render ${productId}] failed:`, err.message);
    await prisma.product
      .update({ where: { id: productId }, data: { renderStatus: "FAILED" } })
      .catch(() => {});
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Deletes every rendered page's R2 object and DB row for a product. Used
// when the admin deletes a product outright, or re-uploads a new PDF over an
// existing one (the old pages are no longer valid and must not linger in
// R2 running up storage costs).
async function clearRenderedPages(productId) {
  const pages = await prisma.renderedPage.findMany({ where: { productId } });
  for (const page of pages) {
    await deleteObject(page.imageKey).catch((err) =>
      console.error(`[render ${productId}] failed to delete ${page.imageKey}:`, err.message)
    );
  }
  await prisma.renderedPage.deleteMany({ where: { productId } });
}

module.exports = { renderProduct, clearRenderedPages, RENDER_DPI };
