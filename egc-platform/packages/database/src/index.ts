import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

let client: ReturnType<typeof postgres> | undefined;
let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!client) client = postgres(process.env.DATABASE_URL, { max: 10 });
  if (!instance) instance = drizzle(client, { schema });
  return instance;
}

export { schema };
export * from "./schema.js";
