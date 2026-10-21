const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PORT, ROOT, loadEnv } = require("./server/config");
const { initDatabase } = require("./server/database");
const { sendJson } = require("./server/http-utils");
const { applySecurityHeaders } = require("./server/security-headers");
const { resolveApiHandlerPath } = require("./server/http/api-routes");
const { serveStaticFile } = require("./server/static");
const pricing = require("./server/ai/pricing");

loadEnv();

// Warm the live OpenRouter price catalog so observability cost estimates use
// real per-token prices instead of fallback defaults. Non-blocking: a slow or
// failed catalog refresh must not delay requests.
pricing.refreshCatalog().catch(() => {});

let isDbInitialized = false;

const requestHandler = async (req, res) => {
  try {
    if (!isDbInitialized) {
      await initDatabase();
      isDbInitialized = true;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Serve the OpenAPI JSON spec document (it is data, not a request handler).
    if (url.pathname === "/api/openapi.json") {
      const specPath = path.join(ROOT, "api", "openapi.json");
      if (!fs.existsSync(specPath)) return sendJson(res, 404, { error: "Spec not found" });
      applySecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return fs.createReadStream(specPath).pipe(res);
    }

    if (url.pathname.startsWith("/api/")) {
      const handlerPath = resolveApiHandlerPath(url.pathname);
      if (!handlerPath) return sendJson(res, 404, { error: "API endpoint not found" });
      return await require(handlerPath)(req, res);
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    return serveStaticFile(res, ROOT, url.pathname);
  } catch (error) {
    console.error(error);
    // A streaming handler may fail after its headers were sent.
    if (res.headersSent) return res.end();
    return sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
};

module.exports = requestHandler;

if (require.main === module) {
  // Read after loadEnv() so HOST/PORT from .env apply; config.PORT is resolved
  // at require time, before .env is loaded. Default stays loopback-only.
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || PORT;
  const server = http.createServer(requestHandler);
  initDatabase()
    .then(() => {
      server.listen(port, host, () => {
        console.log(`Lisan.ai running at http://${host}:${port}`);
        console.log(`Using OpenRouter model: ${process.env.OPENROUTER_MODEL}`);
      });
    })
    .catch((error) => {
      console.error("Gagal menyiapkan database:", error);
      process.exit(1);
    });
}
