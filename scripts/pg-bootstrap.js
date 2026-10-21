// Create the least-privilege application role and databases on a PostgreSQL
// server, using an administrator connection taken from the standard libpq
// environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD). Example:
//
//   node --env-file=%USERPROFILE%\.lisanai\pg-admin.env scripts/pg-bootstrap.js
//
// Options:
//   --role=<name>          application role (default lisanai_app)
//   --databases=a,b        databases owned by that role (default lisanai,lisanai_test)
//   --rotate-password      set a new password when the role already exists
//   --out=<file>           where the application URLs are written
//                          (default ~/.lisanai/pg-app.env, readable only by you)
//
// The generated password is never printed; it is written to --out only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");

function option(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const role = option("role", "lisanai_app");
const databases = option("databases", "lisanai,lisanai_test").split(",").map((name) => name.trim()).filter(Boolean);
const rotatePassword = process.argv.includes("--rotate-password");
const outFile = option("out", path.join(os.homedir(), ".lisanai", "pg-app.env"));

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// SCRAM-SHA-256 verifier in PostgreSQL's stored format (RFC 5802/7677), so
// CREATE/ALTER ROLE never carries the plaintext password over the wire.
function scramVerifier(password, iterations = 4096) {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// Prefer an encrypted session; fall back to plaintext only if the server has
// SSL disabled, and report which one was used.
async function connectAdmin() {
  const base = { database: process.env.PGDATABASE || "postgres", application_name: "lisanai-bootstrap" };
  const encrypted = new Client({ ...base, ssl: { rejectUnauthorized: false } });
  try {
    await encrypted.connect();
    return { client: encrypted, transportSsl: true };
  } catch (error) {
    await encrypted.end().catch(() => {});
    if (!/does not support SSL/i.test(error.message)) throw error;
  }
  const plain = new Client(base);
  await plain.connect();
  return { client: plain, transportSsl: false };
}

function restrictToCurrentUser(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${user}:(F)`], { stdio: "ignore" });
}

async function main() {
  for (const name of [role, ...databases]) {
    if (!IDENTIFIER.test(name)) throw new Error(`Nama tidak valid: ${name}`);
  }
  if (!process.env.PGHOST || !process.env.PGUSER) throw new Error("Set PGHOST dan PGUSER (mis. lewat --env-file).");

  const { client: admin, transportSsl } = await connectAdmin();
  try {
    const { rows: [server] } = await admin.query("SELECT current_setting('server_version') AS version, current_setting('ssl') AS ssl");
    console.log(`PostgreSQL ${server.version} di ${process.env.PGHOST}:${process.env.PGPORT || 5432}, ssl server=${server.ssl}, koneksi ini ${transportSsl ? "terenkripsi" : "TIDAK terenkripsi"}`);

    const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount > 0;
    let password = null;
    if (!roleExists || rotatePassword) {
      password = crypto.randomBytes(24).toString("hex");
      const verb = roleExists ? "ALTER" : "CREATE";
      // Utility statements cannot take bind parameters; both values are escaped.
      await admin.query(`${verb} ROLE ${admin.escapeIdentifier(role)} LOGIN PASSWORD ${admin.escapeLiteral(scramVerifier(password))}`);
      console.log(`Role ${role}: ${roleExists ? "password diganti" : "dibuat"} (tanpa superuser/createdb/createrole)`);
    } else {
      console.log(`Role ${role}: sudah ada, password tidak diubah (pakai --rotate-password untuk mengganti)`);
    }

    for (const database of databases) {
      const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount > 0;
      const db = admin.escapeIdentifier(database);
      if (exists) {
        await admin.query(`ALTER DATABASE ${db} OWNER TO ${admin.escapeIdentifier(role)}`);
      } else {
        await admin.query(`CREATE DATABASE ${db} OWNER ${admin.escapeIdentifier(role)} ENCODING 'UTF8' TEMPLATE template0`);
      }
      await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
      console.log(`Database ${database}: ${exists ? "sudah ada, owner diset" : "dibuat"}; akses PUBLIC dicabut`);
    }

    if (!password) {
      console.log("Tidak ada password baru, jadi file URL tidak ditulis.");
      return;
    }

    const host = process.env.PGHOST;
    const port = process.env.PGPORT || 5432;
    const url = (database) => `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
    const lines = [
      "# Generated by scripts/pg-bootstrap.js. Contains a password: do not commit or share.",
      `DATABASE_URL=${url(databases[0])}`,
      ...(databases[1] ? [`TEST_DATABASE_URL=${url(databases[1])}`] : []),
      `DATABASE_SSL=${server.ssl === "on" ? "require" : "disable"}`,
    ];
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    restrictToCurrentUser(outFile);
    console.log(`URL koneksi aplikasi ditulis ke ${outFile}`);
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(`pg-bootstrap gagal: ${error.message}`);
  process.exitCode = 1;
});
