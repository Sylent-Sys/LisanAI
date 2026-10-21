const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApiProxy } = require("../server/http/api-proxy");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function withProxy(upstreamHandler, fn) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer(createApiProxy(`http://127.0.0.1:${upstreamPort}`));
  const proxyPort = await listen(proxy);
  try {
    await fn(`http://127.0.0.1:${proxyPort}`, upstreamPort);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([close(proxy), close(upstream)]);
  }
}

test("proxy forwards method, path, body and cookies, and overwrites X-Forwarded-For", async () => {
  let seen;
  await withProxy(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen = { method: req.method, url: req.url, body, headers: req.headers };
        res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": "lisan_session=abc; HttpOnly" });
        res.end(JSON.stringify({ ok: true }));
      });
    },
    async (base) => {
      const response = await fetch(`${base}/api/auth?action=login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "lisan_session=old",
          "X-CSRF-Token": "token-1",
          "X-Forwarded-For": "203.0.113.9",
        },
        body: JSON.stringify({ action: "login" }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { ok: true });
      assert.match(response.headers.get("set-cookie"), /lisan_session=abc/);
    },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/auth?action=login");
  assert.equal(seen.body, JSON.stringify({ action: "login" }));
  assert.equal(seen.headers.cookie, "lisan_session=old");
  assert.equal(seen.headers["x-csrf-token"], "token-1");
  assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1", "a client-supplied X-Forwarded-For must be replaced");
  assert.equal(seen.headers["x-forwarded-proto"], "http");
});

test("proxy streams server-sent events before the upstream response ends", async () => {
  let finish;
  await withProxy(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      finish = () => res.end("data: last\n\n");
    },
    async (base) => {
      const response = await fetch(`${base}/api/notifications`);
      const reader = response.body.getReader();
      const { value } = await reader.read();
      assert.match(Buffer.from(value).toString(), /data: first/);
      finish();
      let rest = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += Buffer.from(chunk.value).toString();
      assert.match(rest, /data: last/);
    },
  );
});

test("proxy answers 502 with a JSON error when the API server is unreachable", async () => {
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await close(probe);

  const proxy = http.createServer(createApiProxy(`http://127.0.0.1:${deadPort}`));
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/state`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /tidak dapat dihubungi/);
  } finally {
    await close(proxy);
  }
});

test("proxy rejects a non-http upstream URL", () => {
  assert.throws(() => createApiProxy("ftp://example.test"), /http:\/\/ atau https:\/\//);
});
