const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbPath = path.join(os.tmpdir(), `oralai-apikeys-route-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.ENABLE_DEMO_SIMULATION = "false";

const apikeysApi = require("../api-internal/apikeys");
const { initDatabase } = require("../server/database");
const {
  createTenantUser,
  registerTenantUser,
  createSession,
  createCsrfToken,
  SESSION_COOKIE,
} = require("../server/auth-service");

let context;
let createdKeyId;

test.before(async () => {
  fs.rmSync(dbPath, { force: true });
  await initDatabase();
  context = await seedScenario();
});

test.after(() => {
  fs.rmSync(dbPath, { force: true });
});

test("GET /api/apikeys without a session returns 401", async () => {
  const res = await callHandler(apikeysApi, { method: "GET", url: "/api/apikeys" });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Unauthorized");
});

test("GET /api/apikeys with a student session returns 403", async () => {
  const session = await createSession(context.student.id);
  const res = await callHandler(apikeysApi, {
    method: "GET",
    url: "/api/apikeys",
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "Forbidden");
});

test("GET /api/apikeys with an admin session returns 200 and a keys array", async () => {
  const session = await createSession(context.admin.id);
  const res = await callHandler(apikeysApi, {
    method: "GET",
    url: "/api/apikeys",
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.keys));
});

test("POST /api/apikeys create with admin session and valid CSRF returns 201 and a raw key", async () => {
  const session = await createSession(context.admin.id);
  const csrfToken = createCsrfToken({ sessionId: session.sessionId, tenant: context.tenant, user: context.admin });
  const res = await callHandler(apikeysApi, {
    method: "POST",
    url: "/api/apikeys",
    body: { action: "create", payload: { name: "Demo Key" } },
    headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "x-csrf-token": csrfToken },
  });

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.key.startsWith("lsk_"));
  assert.equal(res.body.name, "Demo Key");
  assert.ok(res.body.id);
  createdKeyId = res.body.id;
});

test("POST /api/apikeys create without a CSRF header returns 403", async () => {
  const session = await createSession(context.admin.id);
  const res = await callHandler(apikeysApi, {
    method: "POST",
    url: "/api/apikeys",
    body: { action: "create", payload: { name: "No CSRF Key" } },
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "CSRF token tidak valid");
});

test("POST /api/apikeys revoke with admin session and valid CSRF returns 200 { ok: true }", async () => {
  assert.ok(createdKeyId, "create test must run first");
  const session = await createSession(context.admin.id);
  const csrfToken = createCsrfToken({ sessionId: session.sessionId, tenant: context.tenant, user: context.admin });
  const res = await callHandler(apikeysApi, {
    method: "POST",
    url: "/api/apikeys",
    body: { action: "revoke", payload: { keyId: createdKeyId } },
    headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "x-csrf-token": csrfToken },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  const list = await callHandler(apikeysApi, {
    method: "GET",
    url: "/api/apikeys",
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.keys.some((key) => key.id === createdKeyId));
});

async function seedScenario() {
  const { tenant, user: admin } = await registerTenantUser({
    tenantName: "API Keys Route School",
    name: "Admin Route",
    email: "admin.apikeys.route@example.com",
    password: "password123",
  });
  const student = await createTenantUser(tenant.id, {
    name: "Siswa Route",
    email: "siswa.apikeys.route@example.com",
    password: "password123",
    role: "student",
  });
  return { tenant, admin, student };
}

function callHandler(handler, { method, url, body, headers = {} }) {
  // A readable stream buffers the body until the handler reads it, like a real
  // IncomingMessage; a timed emit raced handlers that query the DB first.
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:4173", ...headers };

  const res = {
    headers: {},
    statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(statusCode, responseHeaders = {}) {
      this.statusCode = statusCode;
      Object.entries(responseHeaders).forEach(([name, value]) => this.setHeader(name, value));
    },
    end(payload = "") {
      this.rawBody = String(payload);
      this.body = this.rawBody ? JSON.parse(this.rawBody) : {};
      this.resolve(this);
    },
  };

  const done = new Promise((resolve) => { res.resolve = resolve; });
  handler(req, res);
  return done;
}
