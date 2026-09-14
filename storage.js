// Object storage for master PDFs, cover images, and rendered page images —
// Cloudflare R2, not the local disk. See closed-reader-build-brief.md §8:
// Render's disk is wiped on every restart/redeploy, so anything under
// files/ or uploads/covers/ today does not actually survive reliably.
//
// R2 is S3-compatible, so this uses the standard AWS SDK v3 S3 client
// pointed at R2's endpoint. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME set — see .env.example.
//
// Nothing in server.js reads from this yet; it's scaffolding for the
// upload-time rendering step and the reader's per-page endpoint to build on.

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

function client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error("R2_ACCOUNT_ID is not set");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function bucket() {
  const name = process.env.R2_BUCKET_NAME;
  if (!name) throw new Error("R2_BUCKET_NAME is not set");
  return name;
}

// Uploads a buffer under `key`. Use a namespaced key convention, e.g.
// `products/<productId>/source.pdf` or `products/<productId>/pages/<n>.png`,
// so a product's files are easy to find and delete together.
async function putObject(key, body, contentType) {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

// Reads an object back as a Buffer. Fine for page images (small, one at a
// time); for anything large, prefer streaming instead of buffering fully.
async function getObjectBuffer(key) {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function deleteObject(key) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

module.exports = { putObject, getObjectBuffer, deleteObject };
