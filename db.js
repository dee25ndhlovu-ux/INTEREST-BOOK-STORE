// Prisma client singleton. Import { prisma } from here anywhere that needs
// the database, rather than creating a new PrismaClient per file — Postgres
// connection pools are limited and a fresh client per request/module would
// exhaust them quickly.
//
// Needs DATABASE_URL set to a real Postgres connection string. See
// .env.example. Nothing in server.js reads from this yet — see
// docs/closed-reader-build-brief.md for what's still to be wired up.

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

module.exports = { prisma };
