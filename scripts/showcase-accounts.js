if (process.env.VERCEL_ENV !== "production") {
  console.log(`Skipping showcase account provisioning for VERCEL_ENV=${process.env.VERCEL_ENV || "unknown"}.`);
  process.exit(0);
}

const { loadEnv } = require("../server/config");
loadEnv();
const { getDb, initDatabase } = require("../server/database");
const { createTenantUser } = require("../server/auth-service");

async function main() {
  await initDatabase();
  const db = getDb();
  const admin = await db.get("SELECT * FROM users WHERE email = ?", process.env.SHOWCASE_ADMIN_EMAIL || "demo@lisan.ai");
  if (!admin) throw new Error("Showcase admin belum tersedia.");
  const tenantId = admin.tenant_id || admin.tenantId;
  const password = process.env.SHOWCASE_ADMIN_PASSWORD || "LisanDemo2026!";

  const accounts = [
    { name: "Dosen Demo Lisan.ai", email: process.env.SHOWCASE_TEACHER_EMAIL || "dosen@lisan.ai", role: "teacher" },
    { name: "Student Demo Lisan.ai", email: process.env.SHOWCASE_STUDENT_EMAIL || "student@lisan.ai", role: "student" },
  ];
  for (const account of accounts) {
    const existing = await db.get("SELECT id FROM users WHERE email = ?", account.email);
    if (!existing) await createTenantUser(tenantId, { ...account, password });
  }

  const teacher = await db.get("SELECT id FROM users WHERE email = ?", accounts[0].email);
  const student = await db.get("SELECT id FROM users WHERE email = ?", accounts[1].email);
  const demoClass = await db.get("SELECT * FROM classes WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1", tenantId);
  if (!demoClass) throw new Error("Demo class tidak ditemukan.");

  await db.run("UPDATE classes SET teacher_id = ? WHERE id = ?", teacher.id, demoClass.id);
  await db.run(
    `INSERT INTO class_memberships (id, tenant_id, class_id, student_id, status, requested_at, approved_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?)
     ON CONFLICT DO NOTHING`,
    `showcase-${demoClass.id}-${student.id}`, tenantId, demoClass.id, student.id,
    new Date().toISOString(), new Date().toISOString()
  );
  console.log(`Showcase accounts ready: ${accounts.map(a => a.email).join(", ")}`);
}
main().catch(error => { console.error(error); process.exit(1); });
