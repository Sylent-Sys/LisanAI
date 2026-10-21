// Copy all application data from a SQLite/libSQL database into PostgreSQL.
//
//   node --env-file=<api .env> scripts/migrate-sqlite-to-postgres.js --from=file:C:/path/lisan_ai.db
//
// The target is DATABASE_URL. Its schema is created first (same migrations the
// API runs at boot). The copy refuses to run into a target that already holds
// application rows, runs in one transaction, and verifies row counts at the end.
// Stop the application that writes to the source database before running it.

const { createClient } = require("@libsql/client");
const { initDatabase, getDb, closeDatabase, getDatabaseDialect } = require("../server/database/client");

// Parents before children so foreign keys are satisfied during the copy.
const TABLES = [
  "tenants",
  "users",
  "sessions",
  "classes",
  "class_memberships",
  "assessments",
  "assessment_classes",
  "assessment_attempts",
  "submissions",
  "api_keys",
  "ai_logs",
  "evaluation_runs",
  "evaluation_criteria",
  "evaluation_events",
  "evaluation_human_scores",
  "evaluation_results",
  "evaluation_versions",
  "human_approvals",
  "evaluation_contexts",
  "question_bank",
  "student_competency_state",
  "demo_seeds",
];
const IDENTITY_TABLES = ["evaluation_criteria", "evaluation_events", "evaluation_human_scores", "evaluation_contexts"];
const BATCH_SIZE = 200;

function option(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

async function main() {
  const from = option("from");
  if (!from || !from.startsWith("file:")) throw new Error("Pakai --from=file:<path ke lisan_ai.db>");
  if (getDatabaseDialect() !== "postgres") throw new Error("DATABASE_URL harus mengarah ke PostgreSQL.");

  const source = createClient({ url: from });
  await initDatabase();
  const target = getDb();
  try {
    const sourceTables = new Set((await source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name));

    let existing = 0;
    for (const table of TABLES) existing += Number((await target.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
    if (existing > 0) throw new Error(`Database tujuan sudah berisi ${existing} baris data aplikasi; migrasi dibatalkan.`);

    const plan = [];
    for (const table of TABLES) {
      if (!sourceTables.has(table)) continue;
      const sourceColumns = (await source.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);
      const targetColumns = new Set((await target.all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table,
      )).map((r) => r.column_name));
      const columns = sourceColumns.filter((name) => targetColumns.has(name));
      const dropped = sourceColumns.filter((name) => !targetColumns.has(name));
      if (dropped.length) throw new Error(`Kolom ${table}.${dropped.join(", ")} tidak ada di PostgreSQL; perbarui baseline dulu.`);
      plan.push({ table, columns });
    }

    const copied = {};
    await target.transaction(async (tx) => {
      for (const { table, columns } of plan) {
        const rows = (await source.execute(`SELECT ${columns.join(", ")} FROM ${table}`)).rows;
        for (let start = 0; start < rows.length; start += BATCH_SIZE) {
          const chunk = rows.slice(start, start + BATCH_SIZE);
          const values = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
          const args = chunk.flatMap((row) => columns.map((column) => row[column]));
          await tx.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, ...args);
        }
        copied[table] = rows.length;
      }
      for (const table of IDENTITY_TABLES) {
        if (!copied[table]) continue;
        await tx.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`);
      }
    });

    let mismatches = 0;
    for (const { table } of plan) {
      const sourceCount = Number((await source.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
      const targetCount = Number((await target.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
      const ok = sourceCount === targetCount;
      if (!ok) mismatches += 1;
      console.log(`${ok ? "OK " : "BEDA"} ${table.padEnd(26)} sqlite=${sourceCount} postgres=${targetCount}`);
    }
    if (mismatches) throw new Error(`${mismatches} tabel jumlah barisnya berbeda.`);
    console.log("Migrasi data selesai dan jumlah baris cocok.");
  } finally {
    source.close();
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(`migrate-sqlite-to-postgres gagal: ${error.message}`);
  process.exitCode = 1;
});
