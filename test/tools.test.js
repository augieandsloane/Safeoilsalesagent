import test from "node:test";
import assert from "node:assert/strict";
import { callTool, toolDefinitions } from "../src/tools.js";

test("write tools require write scope", async () => {
  await assert.rejects(
    callTool("create_deal", { fields: { title: "Prospect" } }, { scopes: ["pipedrive:read"], pipedrive: {}, accountId: "1", db: {} }),
    /pipedrive:write/
  );
});

test("write tools reject credential fields", async () => {
  await assert.rejects(
    callTool("create_deal", { fields: { title: "Prospect", access_token: "bad" } }, { scopes: ["pipedrive:write"], pipedrive: {}, accountId: "1", db: {} }),
    /Credential fields/
  );
});

test("search is bounded and account-scoped", async () => {
  const calls = [];
  const pipedrive = { request: async (...args) => { calls.push(args); return { data: { items: [{ item: { id: 9 } }] } }; } };
  const result = await callTool("search_deals", { term: "Harbor", limit: 999 }, { scopes: ["pipedrive:read"], pipedrive, accountId: "company:user", db: {} });
  assert.equal(calls[0][0], "company:user");
  assert.match(calls[0][2], /limit=50/);
  assert.equal(result.structuredContent.items.length, 1);
});

test("all mutation tools advertise non-read-only behavior", () => {
  for (const tool of toolDefinitions.filter((item) => /^(create|update|delete)_/.test(item.name))) {
    assert.equal(tool.annotations.readOnlyHint, false, tool.name);
  }
});

test("delete tools are marked destructive and require write scope", async () => {
  for (const tool of toolDefinitions.filter((item) => item.name.startsWith("delete_"))) {
    assert.equal(tool.annotations.destructiveHint, true, tool.name);
  }
  await assert.rejects(
    callTool("delete_deal", { id: 44 }, { scopes: ["pipedrive:read"], pipedrive: {}, accountId: "1", db: {} }),
    /pipedrive:write/
  );
});
