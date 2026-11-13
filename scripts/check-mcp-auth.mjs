import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/server-ads-fixed.ts", import.meta.url), "utf8");
const entry = source.slice(source.indexOf("export default {"));
assert.ok(entry.includes('if (url.pathname === "/mcp")'), "MCP entry route missing");
const authIndex = entry.indexOf("request.headers.get(\"authorization\")");
const interceptIndex = entry.indexOf("await interceptMcpToolCall(request, env)");
assert.ok(authIndex >= 0 && interceptIndex >= 0 && authIndex < interceptIndex, "MCP must authenticate BEFORE Ads interception");
assert.ok(entry.includes("if (!env.MCP_SHARED_SECRET)"), "Missing MCP secret must fail closed");
assert.ok(entry.includes('status: 401'), "Unauthorized MCP requests must be rejected");
assert.ok(entry.includes('status: 503'), "Unconfigured MCP authentication must be rejected");
console.log("MCP Ads authentication order: PASS");
