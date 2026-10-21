const { Pool, types } = require("pg");

// SQLite returns integers and aggregates as JS numbers. Match that so callers
// behave the same on both dialects (COUNT/SUM are int8/numeric in PostgreSQL,
// which node-postgres would otherwise return as strings).
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const positionalCache = new Map();

// Rewrite SQLite-style `?` placeholders to PostgreSQL `$n`, skipping quoted
// strings, quoted identifiers and comments.
function toPositionalSql(sql) {
  const cached = positionalCache.get(sql);
  if (cached) return cached;

  let out = "";
  let index = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "'" || char === '"') {
      const end = findClosingQuote(sql, i, char);
      out += sql.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length - 1 : end;
      out += sql.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length - 1 : end + 1;
      out += sql.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "?") {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }

  if (positionalCache.size > 2000) positionalCache.clear();
  positionalCache.set(sql, out);
  return out;
}

function findClosingQuote(sql, start, quote) {
  for (let i = start + 1; i < sql.length; i += 1) {
    if (sql[i] !== quote) continue;
    if (sql[i + 1] === quote) {
      i += 1;
      continue;
    }
    return i;
  }
  return sql.length - 1;
}

function normalizeParams(params) {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return list.map(normalizeValue);
}

// Keep the values SQLite would have stored: booleans become 0/1 because the
// schema uses INTEGER flags, and dates become ISO-8601 text columns.
function normalizeValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function resolveSsl(mode) {
  switch (String(mode || "").toLowerCase()) {
    case "":
    case "disable":
      return undefined;
    case "require":
      // Encrypted, but the server certificate is not verified.
      return { rejectUnauthorized: false };
    case "verify":
      return { rejectUnauthorized: true };
    default:
      throw new Error(`DATABASE_SSL tidak dikenal: ${mode} (pakai disable | require | verify)`);
  }
}

function resolveSchema(value) {
  if (!value) return null;
  // Per-process schema so parallel test processes never share tables.
  const schema = value === "auto" ? `t_${process.pid}_${Date.now().toString(36)}` : value;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`DATABASE_SCHEMA tidak valid: ${schema}`);
  return schema;
}

function wrapQueryable(queryable, extras) {
  const query = (sql, params) => queryable.query(toPositionalSql(sql), normalizeParams(params));
  return {
    dialect: "postgres",
    async all(sql, ...params) {
      return (await query(sql, params)).rows;
    },
    async get(sql, ...params) {
      return (await query(sql, params)).rows[0];
    },
    async run(sql, ...params) {
      const result = await query(sql, params);
      return { changes: result.rowCount ?? 0, lastInsertRowid: undefined };
    },
    async exec(sql) {
      // Simple-query protocol: multiple statements, no parameters.
      await queryable.query(sql);
    },
    ...extras,
  };
}

async function createPostgresDatabase(connectionString, options = {}) {
  const schema = resolveSchema(options.schema);
  const pool = new Pool({
    connectionString,
    ssl: resolveSsl(options.ssl),
    max: Number(options.poolMax) || 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: "lisanai",
    // Let short-lived processes (scripts, test files) exit once idle.
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => console.error("PostgreSQL pool error:", error.message));

  if (schema) {
    // Attached before the first query so every pooled connection gets it; the
    // SET is queued ahead of the caller's query on that connection.
    pool.on("connect", (client) => {
      client.query(`SET search_path TO ${schema}`).catch((error) => console.error("SET search_path gagal:", error.message));
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = wrapQueryable(client, { transaction: (inner) => inner(tx) });
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function batch(statements) {
    await transaction(async (tx) => {
      for (const statement of statements) await tx.run(statement.sql, ...(statement.args || []));
    });
  }

  return wrapQueryable(pool, {
    schema,
    transaction,
    batch,
    close: () => pool.end(),
  });
}

function isPostgresUrl(url) {
  return /^postgres(ql)?:\/\//i.test(String(url || ""));
}

module.exports = { createPostgresDatabase, isPostgresUrl, toPositionalSql, normalizeValue };
