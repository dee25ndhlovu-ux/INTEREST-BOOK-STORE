// Prisma 7 config file — the CLI (generate/migrate) reads DATABASE_URL from
// here now instead of from schema.prisma's datasource block. See
// prisma/schema.prisma for why. Needs DATABASE_URL set in the environment
// (Render's env vars, or .env locally).
require("dotenv/config");
const { defineConfig } = require("prisma/config");

module.exports = defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
