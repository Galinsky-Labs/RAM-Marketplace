import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations"
  },
  datasource: {
    // Migrations prefer a direct (non-pooled) connection when provided, e.g.
    // Neon's direct host; the runtime adapter always uses DATABASE_URL.
    url:
      process.env.DIRECT_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/ram_marketplace"
  }
});
