const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("../config");

const API_DIR = path.join(ROOT, "api");

// Mirrors the /api rewrites in vercel.json so self-hosted servers dispatch to
// the same handler files as the Vercel deployment. Handlers such as api/data.js
// and api/admin.js branch on the original pathname, so only the file is aliased.
const API_ROUTE_ALIASES = {
  database: "data",
  health: "data",
  notifications: "data",
  probing: "evaluation",
  "evidence-feedback": "evaluation",
  apikeys: "auth",
  docs: "v1",
  research: "admin",
  observability: "admin",
};

// Only files that exist in api/ are dispatchable, so a crafted path segment can
// never reach require() with an arbitrary module name.
const API_HANDLERS = new Set(
  fs.readdirSync(API_DIR)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.slice(0, -3)),
);

function resolveApiHandlerPath(pathname) {
  if (!pathname.startsWith("/api/")) return null;
  const segment = pathname.slice("/api/".length).split("/")[0];
  const name = Object.hasOwn(API_ROUTE_ALIASES, segment) ? API_ROUTE_ALIASES[segment] : segment;
  return API_HANDLERS.has(name) ? path.join(API_DIR, `${name}.js`) : null;
}

module.exports = { API_ROUTE_ALIASES, resolveApiHandlerPath };
