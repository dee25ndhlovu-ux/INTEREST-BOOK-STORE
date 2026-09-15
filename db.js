// Prisma client singleton. Import { prisma } from here anywhere that needs
// the database, rather than creating a new PrismaClient per file — Postgres
// connection pools are limited and a fresh client per request/module would
// exhaust them quickly.
//
// Prisma 7 requires a driver adapter for a direct Postgres connection at
// runtime (this is separate from prisma.config.js, which only covers the
// CLI/migrations) — see @prisma/adapter-pg below.
//
// Needs DATABASE_URL set to a real Postgres connection string. See
// .env.example. Nothing in server.js reads from this yet — see
// docs/closed-reader-build-brief.md for what's still to be wired up.

const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
