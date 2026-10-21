const http = require("node:http");
const https = require("node:https");
const { sendJson } = require("../http-utils");

// Hop-by-hop headers describe a single connection and must not be forwarded.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function withoutHopByHop(headers) {
  const copy = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete copy[name];
  return copy;
}

function clientAddress(req) {
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

// Forwards /api/* from the web server to the API server unchanged, streaming
// both bodies so SSE responses reach the browser as they are produced.
function createApiProxy(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`API_UPSTREAM_URL harus http:// atau https:// (diterima: ${upstreamUrl})`);
  }
  const transport = upstream.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: true });

  return function proxyApiRequest(req, res) {
    const headers = withoutHopByHop(req.headers);
    // Overwrite instead of append: the API keys its login rate limit on the
    // first X-Forwarded-For entry, so a client-supplied value must not survive.
    headers["x-forwarded-for"] = clientAddress(req);
    headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
    headers["x-forwarded-host"] = req.headers.host || "";

    const upstreamReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
        agent,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, withoutHopByHop(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      console.error(`API proxy error (${req.method} ${req.url.split("?")[0]}): ${error.message}`);
      if (!res.headersSent) return sendJson(res, 502, { error: "Layanan API sedang tidak dapat dihubungi. Coba lagi beberapa saat." });
      res.destroy(error);
    });
    // Stop the upstream call (for example an SSE stream) when the browser leaves.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });

    req.pipe(upstreamReq);
  };
}

module.exports = { createApiProxy };
