const crypto = require("node:crypto");
const { getDb } = require("./database");

const SESSION_COOKIE = "lisan_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function registerTenantUser({ tenantName, name, email, password }) {
  validateCredentials({ email, password });
  const database = getDb();
  const now = new Date().toISOString();
  const tenant = {
    id: uid("tenant"),
    name: String(tenantName || "Tenant Baru").trim(),
    plan: "starter",
    createdAt: now,
  };
  const user = {
    id: uid("user"),
    tenantId: tenant.id,
    name: String(name || "Admin").trim(),
    email: normalizeEmail(email),
    role: "admin",
    createdAt: now,
  };
  const existing = await database.get("SELECT id FROM users WHERE email = ?", user.email);
  if (existing) throw Object.assign(new Error("Email sudah terdaftar"), { status: 409 });

  const passwordHash = await hashPassword(password);
  // transaction() pins one connection; with a PostgreSQL pool, separate
  // BEGIN/COMMIT calls could land on different connections.
  await database.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO tenants (id, name, plan, created_at) VALUES (?, ?, ?, ?)",
      tenant.id,
      tenant.name,
      tenant.plan,
      tenant.createdAt
    );
    await tx.run(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      user.tenantId,
      user.name,
      user.email,
      passwordHash,
      user.role,
      user.createdAt
    );
  });

  return { tenant, user };
}

async function createTenantUser(tenantId, { name, email, password, role }) {
  validateCredentials({ email, password });
  const normalizedRole = normalizeRole(role);
  const database = getDb();
  const user = {
    id: uid("user"),
    tenantId,
    name: String(name || "").trim(),
    email: normalizeEmail(email),
    role: normalizedRole,
    createdAt: new Date().toISOString(),
  };

  if (!user.name) throw Object.assign(new Error("Nama user wajib diisi"), { status: 400 });
  const existing = await database.get("SELECT id FROM users WHERE email = ?", user.email);
  if (existing) throw Object.assign(new Error("Email sudah terdaftar"), { status: 409 });

  await database.run(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    user.id,
    user.tenantId,
    user.name,
    user.email,
    await hashPassword(password),
    user.role,
    user.createdAt
  );

  return user;
}

async function listTenantUsers(tenantId) {
  const rows = await getDb().all(
    "SELECT id, tenant_id, name, email, role, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC",
    tenantId
  );
  return rows.map(mapUser);
}

async function updateTenantUser(tenantId, userId, patch) {
  const existing = await getDb().get("SELECT * FROM users WHERE id = ? AND tenant_id = ?", userId, tenantId);
  if (!existing) throw Object.assign(new Error("User tidak ditemukan"), { status: 404 });
  const name = String(patch.name || existing.name).trim();
  const role = patch.role ? normalizeRole(patch.role) : existing.role;
  await getDb().run(
    "UPDATE users SET name = ?, role = ? WHERE id = ? AND tenant_id = ?",
    name,
    role,
    userId,
    tenantId
  );
  return mapUser({ ...existing, name, role });
}

async function deleteTenantUser(tenantId, userId, currentUserId) {
  if (userId === currentUserId) throw Object.assign(new Error("Tidak bisa menghapus akun sendiri"), { status: 400 });
  const result = await getDb().run("DELETE FROM users WHERE id = ? AND tenant_id = ?", userId, tenantId);
  if (!result.changes) throw Object.assign(new Error("User tidak ditemukan"), { status: 404 });
}

async function loginUser({ email, password }) {
  validateCredentials({ email, password });
  const database = getDb();
  const row = await database.get(
    `SELECT users.*, tenants.name AS tenant_name, tenants.plan AS tenant_plan
     FROM users
     JOIN tenants ON tenants.id = users.tenant_id
     WHERE users.email = ?`,
    normalizeEmail(email)
  );

  if (!row) {
    throw Object.assign(new Error("Akun belum terdaftar. Silakan daftar terlebih dahulu."), { status: 404 });
  }

  if (!(await verifyPassword(password, row.password_hash))) {
    throw Object.assign(new Error("Password salah"), { status: 401 });
  }

  return {
    tenant: mapTenant(row),
    user: mapUser(row),
  };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const sessionId = uid("session");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await getDb().run(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    sessionId,
    userId,
    tokenHash,
    expiresAt,
    now.toISOString()
  );

  return { token, sessionId, expiresAt };
}

async function getSessionUser(token) {
  if (!token) return null;
  const row = await getDb().get(
    `SELECT sessions.id AS session_id, sessions.expires_at, users.*, tenants.name AS tenant_name, tenants.plan AS tenant_plan
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     JOIN tenants ON tenants.id = users.tenant_id
     WHERE sessions.token_hash = ?`,
    hashToken(token)
  );
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    await deleteSession(token);
    return null;
  }
  return {
    sessionId: row.session_id,
    tenant: mapTenant(row),
    user: mapUser(row),
  };
}

async function extendSession(token) {
  if (!token) return null;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const result = await getDb().run(
    "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
    expiresAt,
    hashToken(token)
  );
  return result.changes ? expiresAt : null;
}

async function deleteSession(token) {
  if (!token) return;
  await getDb().run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

function csrfSecret() {
  const secret = process.env.CSRF_SECRET;
  if (secret) return secret;
  const isProduction = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (isProduction) throw new Error("CSRF_SECRET wajib diatur di produksi");
  return "local-dev-secret";
}

function createCsrfToken(auth) {
  if (!auth?.sessionId) return null;
  return hashToken(`csrf:${auth.sessionId}:${csrfSecret()}`);
}

function assertCsrfToken(req, auth) {
  const expected = createCsrfToken(auth);
  const actual = req.headers["x-csrf-token"];
  if (!expected || actual !== expected) {
    throw Object.assign(new Error("CSRF token tidak valid"), { status: 403 });
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = await scrypt(password, salt);
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = await scrypt(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(candidate));
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("base64url"));
    });
  });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validateCredentials({ email, password }) {
  if (!normalizeEmail(email).includes("@")) {
    throw Object.assign(new Error("Email tidak valid"), { status: 400 });
  }
  if (String(password || "").length < 8) {
    throw Object.assign(new Error("Password minimal 8 karakter"), { status: 400 });
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (!["admin", "teacher", "student"].includes(normalized)) {
    throw Object.assign(new Error("Role tidak valid"), { status: 400 });
  }
  return normalized;
}

function mapTenant(row) {
  return {
    id: row.tenant_id,
    name: row.tenant_name,
    plan: row.tenant_plan,
  };
}

function mapUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    role: row.role,
  };
}

async function createTenantUsersBatch(tenantId, users) {
  const success = [];
  const errors = [];

  for (const [index, userPayload] of users.entries()) {
    try {
      const user = await createTenantUser(tenantId, userPayload);
      success.push(user);
    } catch (error) {
      errors.push({
        row: index + 1,
        email: userPayload.email,
        message: error.message
      });
    }
  }

  return { success, errors };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createTenantUser,
  createTenantUsersBatch,
  createSession,
  createCsrfToken,
  deleteTenantUser,
  deleteSession,
  extendSession,
  getSessionUser,
  assertCsrfToken,
  listTenantUsers,
  loginUser,
  registerTenantUser,
  updateTenantUser,
};
