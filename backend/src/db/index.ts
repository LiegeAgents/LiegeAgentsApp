import { Pool } from "pg";
import { env } from "../config.js";

const databaseUrl = new URL(env.DATABASE_URL);
const sslMode = databaseUrl.searchParams.get("sslmode");
export const db = new Pool({
  connectionString: env.DATABASE_URL,
  ...(sslMode === "verify-full" || sslMode === "verify-ca"
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});
