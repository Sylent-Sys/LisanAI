const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { resolveApiHandlerPath } = require("../server/http/api-routes");

const ROOT = path.join(__dirname, "..");
const API_DIR = path.join(ROOT, "api");

test("self-hosted /api routing matches every literal vercel.json rewrite", () => {
  const { routes } = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const literal = routes.filter((route) => /^\/api\/[a-z0-9-]+$/.test(route.src) && /^\/api\/[a-z0-9-]+\.js$/.test(route.dest));
  assert.ok(literal.length >= 10, "expected the vercel.json alias table to be parsed");

  for (const route of literal) {
    assert.equal(resolveApiHandlerPath(route.src), path.join(ROOT, route.dest), `route ${route.src}`);
  }
});

test("versioned and docs subpaths dispatch to the v1 handler", () => {
  const v1 = path.join(API_DIR, "v1.js");
  assert.equal(resolveApiHandlerPath("/api/v1/assessments"), v1);
  assert.equal(resolveApiHandlerPath("/api/docs"), v1);
  assert.equal(resolveApiHandlerPath("/api/docs/index.html"), v1);
});

test("direct handlers resolve by file name", () => {
  for (const name of ["auth", "state", "assessment", "competency-trajectory", "benchmark-experiment"]) {
    assert.equal(resolveApiHandlerPath(`/api/${name}`), path.join(API_DIR, `${name}.js`));
  }
});

test("unknown or crafted segments never resolve to a module", () => {
  for (const pathname of [
    "/api/does-not-exist",
    "/api/",
    "/api/constructor",
    "/api/__proto__",
    "/api/..%2fserver%2fconfig",
    "/api/openapi.json",
    "/server/config",
  ]) {
    assert.equal(resolveApiHandlerPath(pathname), null, pathname);
  }
});
