// Read-only migration status report.
//
// Prints which files in server/migrations/ (or server/migrations/postgres/ when
// DATABASE_URL is PostgreSQL) have been recorded in schema_migrations and which
// are still pending. It never applies migrations and never calls
// initDatabase(). Use `--check` for pre-deploy gating: it exits 1 when at least
// one migration is pending.

const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");
const { loadEnv, ROOT } = require("../server/config");
const { isPostgresUrl } = require("../server/database/postgres");

loadEnv();

const check = process.argv.includes("--check");

// Minimal libSQL-shaped client so main() below stays dialect-agnostic.
function createPostgresStatusClient(connectionString) {
  const { Client } = require("pg");
  const client = new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined,
  });
  const ready = client.connect();
  return {
    async execute(sql) {
      await ready;
      return { rows: (await client.query(sql)).rows };
    },
    close: () => client.end(),
  };
}

async function readApplied(client) {
  try {
    const result = await client.execute("SELECT version, name FROM schema_migrations ORDER BY version ASC");
    return result.rows;
  } catch (error) {
    // The table does not exist until initDatabase() runs: treat everything as pending.
    if (/no such table|does not exist/i.test(String(error && error.message))) return [];
    throw error;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL or TURSO_DATABASE_URL");

  const postgres = isPostgresUrl(databaseUrl);
  const client = postgres
    ? createPostgresStatusClient(databaseUrl)
    : createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const migrationsDir = path.join(ROOT, "server", "migrations", ...(postgres ? ["postgres"] : []));
    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort()
      : [];

    const applied = await readApplied(client);
    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    const pending = files.filter((file) => !appliedVersions.has(Number(file.split("_")[0])));

    console.log(`Applied (${applied.length}):`);
    for (const row of applied) console.log(`  ${row.name}`);
    console.log(`Pending (${pending.length}):`);
    for (const file of pending) console.log(`  ${file.replace(/\.sql$/, "")}`);

    if (check && pending.length > 0) process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`migrate-status gagal: ${error.message}`);
  process.exitCode = 1;
});
