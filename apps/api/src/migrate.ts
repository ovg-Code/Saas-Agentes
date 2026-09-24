// Aplica db/migrations/*.sql en orden (una vez cada una). Uso: DATABASE_ADMIN_URL=... pnpm --filter @agentes/api migrate
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const dir = process.env.MIGRATIONS_DIR ?? new URL("../../../db/migrations", import.meta.url).pathname;
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL ?? "postgres://agentes:agentes@localhost:5432/agentes" });
await client.connect();
const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
const applied = new Set<string>(
  exists.rows[0].t ? (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version) : [],
);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  await client.query("BEGIN");
  try {
    await client.query(readFileSync(join(dir, file), "utf8"));
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`aplicada ${file}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`fallo en ${file}:`, (e as Error).message);
    process.exit(1);
  }
}
await client.end();
