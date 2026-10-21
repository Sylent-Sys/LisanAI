const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const ACME_PREFIX = "/.well-known/acme-challenge/";
const ACME_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HOST_HEADER = /^[A-Za-z0-9.\-[\]:]+$/;

// Serves HTTP-01 challenge files written by the ACME client. Only plain token
// names are accepted, so a request can never read outside challengeDir.
function serveAcmeChallenge(req, res, challengeDir) {
  if (!challengeDir || req.method !== "GET") return false;
  const pathname = String(req.url || "").split("?")[0];
  if (!pathname.startsWith(ACME_PREFIX)) return false;

  const token = pathname.slice(ACME_PREFIX.length);
  const file = ACME_TOKEN.test(token) ? path.join(challengeDir, token) : null;
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(fs.readFileSync(file));
  return true;
}

function redirectToHttps(req, res, httpsPort) {
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  if (!host || !HOST_HEADER.test(host)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  const port = Number(httpsPort) === 443 ? "" : `:${httpsPort}`;
  // 308 keeps the method and body, so API calls from an http:// tab still work.
  res.writeHead(308, { Location: `https://${host}${port}${req.url}` });
  res.end();
}

// Starts the HTTP listener and, once a certificate exists, the HTTPS listener.
// Until then HTTP serves the app so the first HTTP-01 validation can pass;
// afterwards HTTP only answers ACME challenges and redirects. The certificate
// file is polled and hot-swapped, because short-lived certificates are
// replaced every few days. The renewal job writes the key first and the
// certificate last.
function startServers({
  handler,
  host,
  httpPort,
  httpsPort,
  certFile,
  keyFile,
  challengeDir,
  pollIntervalMs = 30_000,
  log = console,
}) {
  const tlsConfigured = Boolean(httpsPort && certFile && keyFile);
  let httpsServer = null;

  function startOrReloadTls() {
    if (!tlsConfigured || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) return;
    let context;
    try {
      context = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
      if (httpsServer) {
        httpsServer.setSecureContext(context);
        log.log(`TLS certificate reloaded from ${certFile}`);
        return;
      }
      httpsServer = https.createServer(context, handler);
    } catch (error) {
      log.error(`TLS certificate not loaded, keeping the current state: ${error.message}`);
      return;
    }
    httpsServer.on("error", (error) => log.error(`HTTPS listener error: ${error.message}`));
    httpsServer.listen(httpsPort, host, () => log.log(`Lisan.ai HTTPS at https://${host}:${httpsPort}`));
  }

  const httpServer = http.createServer((req, res) => {
    if (serveAcmeChallenge(req, res, challengeDir)) return;
    if (httpsServer?.listening) return redirectToHttps(req, res, httpsPort);
    return handler(req, res);
  });
  httpServer.listen(httpPort, host);

  if (tlsConfigured) {
    if (!fs.existsSync(certFile)) log.log(`Waiting for a TLS certificate at ${certFile}; serving HTTP until it exists.`);
    startOrReloadTls();
    fs.watchFile(certFile, { interval: pollIntervalMs }, startOrReloadTls);
  }

  return {
    httpServer,
    getHttpsServer: () => httpsServer,
    close() {
      if (tlsConfigured) fs.unwatchFile(certFile);
      const closing = [httpServer, httpsServer].filter(Boolean).map((server) => new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }));
      return Promise.all(closing);
    },
  };
}

module.exports = { startServers, serveAcmeChallenge, redirectToHttps };
