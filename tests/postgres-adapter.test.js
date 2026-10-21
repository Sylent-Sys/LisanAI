const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { toPositionalSql, normalizeValue, isPostgresUrl } = require("../server/database/postgres");
const { MIGRATIONS_DIR, POSTGRES_MIGRATIONS_DIR, isForeignKeyViolation } = require("../server/database/client");

const BASELINE_VERSION = 22;

test("placeholders become $n outside quotes and comments only", () => {
  assert.equal(
    toPositionalSql("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? -- ?\nAND d = ? /* ? */"),
    "SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2 -- ?\nAND d = $3 /* ? */",
  );
  assert.equal(toPositionalSql("SELECT 'it''s ?', ?"), "SELECT 'it''s ?', $1");
  assert.equal(toPositionalSql("SELECT 1"), "SELECT 1");
});

test("parameter values are normalised to what SQLite stored", () => {
  assert.equal(normalizeValue(true), 1);
  assert.equal(normalizeValue(false), 0);
  assert.equal(normalizeValue(undefined), null);
  assert.equal(normalizeValue(new Date("2026-01-02T03:04:05.000Z")), "2026-01-02T03:04:05.000Z");
  assert.equal(normalizeValue("x"), "x");
});

test("postgres URLs are detected; SQLite/libSQL URLs are not", () => {
  assert.ok(isPostgresUrl("postgres://u@h/db"));
  assert.ok(isPostgresUrl("postgresql://u@h:5432/db"));
  assert.ok(!isPostgresUrl("file:./data/lisan_ai.db"));
  assert.ok(!isPostgresUrl("libsql://db.turso.io"));
  assert.ok(!isPostgresUrl(undefined));
});

test("foreign-key violations are recognised for both dialects", () => {
  assert.ok(isForeignKeyViolation({ code: "23503", message: "insert or update violates foreign key constraint" }));
  assert.ok(isForeignKeyViolation(new Error("SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed")));
  assert.ok(!isForeignKeyViolation({ code: "23505", message: "duplicate key value" }));
});

test("every SQLite migration after the baseline has a PostgreSQL counterpart", () => {
  const versions = (dir) => fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).map((f) => Number(f.split("_")[0]));
  const sqlite = versions(MIGRATIONS_DIR).filter((v) => v > BASELINE_VERSION);
  const postgres = new Set(versions(POSTGRES_MIGRATIONS_DIR));
  assert.ok(postgres.has(BASELINE_VERSION), "PostgreSQL baseline must be version 022");
  for (const version of sqlite) {
    assert.ok(postgres.has(version), `migration ${String(version).padStart(3, "0")} is missing in server/migrations/postgres/`);
  }
  assert.ok(Math.max(...versions(MIGRATIONS_DIR)) <= Math.max(...postgres), "PostgreSQL migrations are behind SQLite");
});

test("the database client does not load the native libSQL driver until SQLite is used", () => {
  const { execFileSync } = require("node:child_process");
  const loaded = execFileSync(process.execPath, [
    "-e",
    "require('./server/database'); require('./server/auth-service');" +
      "process.stdout.write(String(Object.keys(require.cache).some((p) => /[\\\\/]@?libsql[\\\\/]/.test(p))))",
  ], { cwd: path.join(__dirname, "..") }).toString();
  assert.equal(loaded, "false");
});

const postgresUrl = process.env.DATABASE_URL;
const skipPostgres = isPostgresUrl(postgresUrl) ? false : "set DATABASE_URL to a PostgreSQL test database";

test("PostgreSQL baseline has the same tables and columns as the migrated SQLite schema", { skip: skipPostgres }, async () => {
  const sqliteFile = path.join(os.tmpdir(), `oralai-schema-parity-${Date.now()}.db`);
  const { createClient } = require("@libsql/client");
  const { createPostgresDatabase } = require("../server/database/postgres");

  // Build the SQLite reference schema in a child process so this process keeps
  // its PostgreSQL connection settings.
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, ["-e", "require('./server/database/client').initDatabase().then(() => process.exit(0))"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: "", TURSO_DATABASE_URL: `file:${sqliteFile}` },
    stdio: "ignore",
  });

  const sqlite = createClient({ url: `file:${sqliteFile}` });
  const tables = (await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).rows.map((r) => r.name);
  const expected = {};
  for (const table of tables) {
    expected[table] = (await sqlite.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name).sort();
  }
  sqlite.close();
  // Best effort: Windows can keep the file locked briefly after close().
  try { fs.rmSync(sqliteFile, { force: true }); } catch {}

  const schema = `parity_${process.pid}_${Date.now().toString(36)}`;
  const db = await createPostgresDatabase(postgresUrl, { schema, ssl: process.env.DATABASE_SSL });
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    await db.exec(fs.readFileSync(path.join(POSTGRES_MIGRATIONS_DIR, "022_postgres_baseline.sql"), "utf8"));
    const rows = await db.all(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, column_name",
      schema,
    );
    const actual = {};
    for (const row of rows) (actual[row.table_name] ||= []).push(row.column_name);

    for (const [table, columns] of Object.entries(expected)) {
      assert.deepEqual(actual[table], columns, `columns of ${table}`);
    }
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
  }
});
