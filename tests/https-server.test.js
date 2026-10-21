const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { startServers } = require("../server/http/https-server");

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeCertificate(dir, name) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", `/CN=${name}`, "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(url) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { rejectUnauthorized: false, agent: false }, (res) => {
      const peer = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body, peerName: peer?.subject?.CN }));
    });
    req.on("error", reject);
  });
}

async function waitFor(check, timeoutMs = 5_000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const silent = { log() {}, error() {} };

test("HTTP serves the app until a certificate exists, then HTTPS takes over with hot reload", { skip: hasOpenssl() ? false : "openssl is not available" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisan-tls-"));
  const challengeDir = path.join(dir, "challenge");
  fs.mkdirSync(challengeDir);
  fs.writeFileSync(path.join(challengeDir, "tokenABCDEFGHIJ_12345"), "tokenABCDEFGHIJ_12345.thumbprint");
  const certFile = path.join(dir, "fullchain.pem");
  const keyFile = path.join(dir, "key.pem");
  const first = makeCertificate(dir, "first-cert");
  const second = makeCertificate(dir, "second-cert");

  const [httpPort, httpsPort] = [await freePort(), await freePort()];
  const servers = startServers({
    handler: (req, res) => res.end(`app:${req.socket.encrypted ? "https" : "http"}:${req.url}`),
    host: "127.0.0.1",
    httpPort,
    httpsPort,
    certFile,
    keyFile,
    challengeDir,
    pollIntervalMs: 50,
    log: silent,
  });
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const httpsBase = `https://127.0.0.1:${httpsPort}`;

  try {
    await waitFor(() => servers.httpServer.listening);

    // No certificate yet: the app stays reachable over HTTP.
    assert.equal((await request(`${httpBase}/page`)).body, "app:http:/page");
    const challenge = await request(`${httpBase}/.well-known/acme-challenge/tokenABCDEFGHIJ_12345`);
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body, "tokenABCDEFGHIJ_12345.thumbprint");
    for (const bad of ["..%2Fkey.pem", "short", "missingToken_1234567890"]) {
      assert.equal((await request(`${httpBase}/.well-known/acme-challenge/${bad}`)).status, 404, bad);
    }

    // The renewal job writes the key first and the certificate last.
    fs.writeFileSync(keyFile, first.key);
    fs.writeFileSync(certFile, first.cert);
    await waitFor(() => servers.getHttpsServer()?.listening);

    const redirect = await request(`${httpBase}/page?x=1`);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `${httpsBase}/page?x=1`);
    assert.equal((await request(`${httpBase}/.well-known/acme-challenge/tokenABCDEFGHIJ_12345`)).status, 200, "challenges stay on HTTP");

    const secure = await request(`${httpsBase}/page`);
    assert.equal(secure.body, "app:https:/page");
    assert.equal(secure.peerName, "first-cert");

    // Renewal: swapped in without a restart.
    fs.writeFileSync(keyFile, second.key);
    fs.writeFileSync(certFile, second.cert);
    await waitFor(async () => (await request(`${httpsBase}/`)).peerName === "second-cert");

    // A broken file keeps the last good certificate instead of failing.
    fs.writeFileSync(certFile, "not a certificate");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await request(`${httpsBase}/`)).peerName, "second-cert");
  } finally {
    await servers.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("without HTTPS settings only the HTTP listener runs and nothing redirects", async () => {
  const httpPort = await freePort();
  const servers = startServers({
    handler: (req, res) => res.end("app"),
    host: "127.0.0.1",
    httpPort,
    log: silent,
  });
  try {
    await waitFor(() => servers.httpServer.listening);
    const response = await request(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/tokenABCDEFGHIJ_12345`);
    assert.equal(response.body, "app", "no challenge dir configured: the app handles the path");
    assert.equal(servers.getHttpsServer(), null);
  } finally {
    await servers.close();
  }
});
