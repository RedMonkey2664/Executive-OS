// One-command Aurora setup: applies db/schema.sql to the database in DATABASE_URL.
// Usage:  npm run db:setup        (reads DATABASE_URL from .env / environment)
// No psql install needed — uses the same `pg` client the app uses.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  /* no .env file — rely on real env vars */
}

const url = process.env.DATABASE_URL ?? process.env.AURORA_DATABASE_URL;
if (!url) {
  console.error("\n✗ DATABASE_URL is not set. Add it to .env (your Aurora connection string) and retry.\n");
  process.exit(1);
}

const schemaPath = path.join(process.cwd(), "db", "schema.sql");
const sql = readFileSync(schemaPath, "utf8");

const pool = new Pool({
  connectionString: url,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

async function main() {
  let host = "(unknown host)";
  try {
    host = new URL(url!.replace(/^postgres(ql)?:/, "http:")).hostname;
  } catch {
    /* ignore */
  }
  console.log(`\n→ Connecting to ${host} …`);
  const v = await pool.query("select version() as version");
  console.log(`✓ Connected: ${String(v.rows[0].version).split(",")[0]}`);
  console.log("→ Applying db/schema.sql …");
  await pool.query(sql);
  const t = await pool.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  console.log(`✓ Schema applied. ${t.rows[0].n} tables in public schema.`);
  console.log("\nDatabase is ready. Start the app and the Aurora chip will turn green.\n");
}

main()
  .catch((e) => {
    console.error(`\n✗ Setup failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error("  Common causes: wrong password, security group not allowing your IP, or SSL.\n");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
