const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");
const { ROOT } = require("../config");
const { createPostgresDatabase, isPostgresUrl } = require("./postgres");

const DATA_DIR = path.join(ROOT, "data");
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
// PostgreSQL starts from a baseline equal to SQLite migrations 001-022; every
// later version must exist in both directories (tests/postgres-adapter.test.js).
const POSTGRES_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, "postgres");
let db;
let libsqlClient;
let postgresUrl;

function normalizeParams(params) {
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

// DATABASE_URL (postgres://...) takes precedence; TURSO_DATABASE_URL keeps
// selecting SQLite/libSQL for local development, tests and Vercel.
function resolveDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL;
}

function getDatabaseDialect() {
  return isPostgresUrl(resolveDatabaseUrl()) ? "postgres" : "sqlite";
}

async function createMigrationsTable() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

async function initPostgres(databaseUrl) {
  // The pool is shared for the process; re-initialising would leak it.
  if (db?.dialect === "postgres" && postgresUrl === databaseUrl) return;
  if (db?.dialect === "postgres") await db.close();
  db = await createPostgresDatabase(databaseUrl, {
    ssl: process.env.DATABASE_SSL,
    schema: process.env.DATABASE_SCHEMA,
    poolMax: process.env.DATABASE_POOL_MAX,
  });
  postgresUrl = databaseUrl;
  await createMigrationsTable();
  await runFileMigrations(POSTGRES_MIGRATIONS_DIR);
}

async function initDatabase() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL or TURSO_DATABASE_URL");
  if (isPostgresUrl(databaseUrl)) return initPostgres(databaseUrl);
  if (databaseUrl.startsWith("file:")) {
    if (process.env.VERCEL) {
      console.error("CRITICAL ERROR: Anda menjalankan Vercel tetapi belum mengatur TURSO_DATABASE_URL di Environment Variables!");
      throw new Error("Missing Turso configuration on Vercel");
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  libsqlClient = createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  db = {
    dialect: "sqlite",
    async all(sql, ...params) {
      const rs = await libsqlClient.execute({ sql, args: normalizeParams(params) });
      return rs.rows;
    },
    async get(sql, ...params) {
      const rs = await libsqlClient.execute({ sql, args: normalizeParams(params) });
      return rs.rows[0];
    },
    async run(sql, ...params) {
      await libsqlClient.execute({ sql: "PRAGMA foreign_keys = ON", args: [] });
      const rs = await libsqlClient.execute({ sql, args: normalizeParams(params) });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
    },
    async exec(sql) {
      await libsqlClient.execute({ sql: "PRAGMA foreign_keys = ON", args: [] });
      await libsqlClient.executeMultiple(sql);
    },
    // Same single-connection BEGIN/COMMIT the callers issued directly before.
    async transaction(fn) {
      await db.run("BEGIN");
      try {
        const result = await fn(db);
        await db.run("COMMIT");
        return result;
      } catch (error) {
        await db.run("ROLLBACK");
        throw error;
      }
    },
    async batch(statements) {
      await libsqlClient.batch(statements, "write");
    },
    close: () => libsqlClient.close(),
  };

  await db.exec("PRAGMA foreign_keys = ON");
  await createMigrationsTable();
  await runFileMigrations();
  await ensureColumn("assessments", "tenant_id", "TEXT");
  await ensureColumn("assessments", "class_id", "TEXT");
  await ensureColumn("assessments", "teacher_id", "TEXT");
  await ensureColumn("assessments", "status", "TEXT DEFAULT 'published'");
  await ensureColumn("submissions", "tenant_id", "TEXT");
  await ensureColumn("submissions", "user_id", "TEXT");
  await ensureColumn("evaluation_runs", "input_hash", "TEXT");
  await ensureColumn("evaluation_runs", "rubric_hash", "TEXT");
  await ensureColumn("evaluation_runs", "attempt_rubric_hash", "TEXT");
  await ensureColumn("evaluation_runs", "prompt_hash", "TEXT");
  await ensureColumn("evaluation_runs", "config_hash", "TEXT");
  await ensureColumn("evaluation_runs", "published", "INTEGER");
  await ensureColumn("evaluation_runs", "requires_human_review", "INTEGER");
  await ensureColumn("evaluation_runs", "context_hash", "TEXT");
  await ensureColumn("evaluation_runs", "context_version", "TEXT");
  await ensureColumn("evaluation_runs", "risk_score", "REAL");
  await ensureColumn("evaluation_runs", "risk_level", "TEXT");
  await ensureColumn("evaluation_runs", "policy_applied", "TEXT");
  await ensureColumn("ai_logs", "run_id", "TEXT");
  await ensureColumn("evaluation_contexts", "expires_at", "TEXT");
}

function getDb() {
  if (!db) throw new Error("Database belum siap");
  return db;
}

async function closeDatabase() {
  if (!db) return;
  const current = db;
  db = undefined;
  postgresUrl = undefined;
  await current.close?.();
}

function isForeignKeyViolation(error) {
  if (error?.code === "23503") return true;
  const message = String(error?.message || error);
  return message.includes("FOREIGN KEY constraint failed") || message.includes("SQLITE_CONSTRAINT_FOREIGNKEY");
}

async function ensureColumn(table, column, type) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Split a SQL script into individual statements on top-level semicolons.
// Quoted strings/identifiers are respected ('...' with '' escapes, "..." with
// "" escapes). `--` line comments are stripped; `/* */` block comments are
// preserved inline. Empty/whitespace-only statements are dropped.
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingle) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      current += char;
      if (char === '"') {
        if (next === '"') {
          current += next;
          i += 1;
        } else {
          inDouble = false;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      current += char + next;
      i += 1;
      inBlockComment = true;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

async function runFileMigrations(migrationsDir = MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    const name = file.replace(/\.sql$/, "");
    const existing = await db.get("SELECT version FROM schema_migrations WHERE version = ?", version);
    if (existing) continue;

    // Apply the migration DDL and record its version in one atomic batch, so a
    // mid-file failure leaves neither partial schema nor a version record.
    const batch = splitSqlStatements(fs.readFileSync(path.join(migrationsDir, file), "utf8")).map((sql) => ({ sql, args: [] }));
    batch.push({
      sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?) ON CONFLICT (version) DO NOTHING",
      args: [version, name, new Date().toISOString()],
    });
    await db.batch(batch);
  }
}

module.exports = {
  initDatabase,
  getDb,
  closeDatabase,
  getDatabaseDialect,
  isForeignKeyViolation,
  runFileMigrations,
  splitSqlStatements,
  MIGRATIONS_DIR,
  POSTGRES_MIGRATIONS_DIR,
};
