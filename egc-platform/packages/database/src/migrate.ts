import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../migrations");

try {
  // MCP pre-deploy and worker startup may migrate the same database concurrently.
  await client`SELECT pg_advisory_lock(173540101)`;
  await migrate(db, { migrationsFolder });
  console.log("EGC database migrations complete");
} finally {
  await client`SELECT pg_advisory_unlock(173540101)`;
  await client.end();
}
