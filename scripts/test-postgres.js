// Run the unit/integration suite against PostgreSQL instead of SQLite.
//
//   node --env-file=%USERPROFILE%\.lisanai\pg-app.env scripts/test-postgres.js
//
// Needs TEST_DATABASE_URL (a database the test role owns). Every test file runs
// in its own process with DATABASE_SCHEMA=auto, i.e. in a fresh schema, so
// files cannot see each other's rows. The schemas are dropped afterwards.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

// SQLite-specific by design (sqlite_master, PRAGMA, libSQL batch semantics).
const SQLITE_ONLY = new Set(["migrations.test.js"]);

async function dropTestSchemas(url) {
  const client = new Client({ connectionString: url, ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^(t|parity)_[0-9]+_[a-z0-9]+$'");
    for (const { nspname } of rows) await client.query(`DROP SCHEMA ${client.escapeIdentifier(nspname)} CASCADE`);
    return rows.length;
  } finally {
    await client.end();
  }
}

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!/^postgres(ql)?:\/\//.test(String(url || ""))) throw new Error("Set TEST_DATABASE_URL ke database PostgreSQL khusus test.");

  const root = path.join(__dirname, "..");
  const files = fs.readdirSync(path.join(root, "tests"))
    .filter((file) => file.endsWith(".test.js") && !SQLITE_ONLY.has(file))
    .filter((file) => process.argv.length <= 2 || process.argv.slice(2).some((pattern) => file.includes(pattern)))
    .map((file) => path.join("tests", file));

  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DATABASE_SCHEMA: "auto" },
  });

  const dropped = await dropTestSchemas(url);
  console.log(`Dropped ${dropped} test schema(s).`);
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(`test-postgres gagal: ${error.message}`);
  process.exitCode = 1;
});
