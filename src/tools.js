const annotations = (readOnly) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const stringId = { anyOf: [{ type: "string" }, { type: "integer" }] };

export const toolDefinitions = [
  {
    name: "pipedrive_profile", title: "Pipedrive profile",
    description: "Return the connected Pipedrive user and company identity. Use to confirm which account is active.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: annotations(true), _meta: { "openai/profile": true },
  },
  ...["organizations", "persons", "deals"].map((entity) => ({
    name: `search_${entity}`, title: `Search Pipedrive ${entity}`,
    description: `Find ${entity} in the connected user's Pipedrive account by name or keyword.`,
    inputSchema: { type: "object", properties: { term: { type: "string", minLength: 2 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, required: ["term"], additionalProperties: false },
    annotations: annotations(true),
  })),
  {
    name: "get_deal", title: "Get Pipedrive deal",
    description: "Retrieve one deal and its current fields before recommending or applying an update.",
    inputSchema: { type: "object", properties: { id: stringId }, required: ["id"], additionalProperties: false },
    annotations: annotations(true),
  },
  ...["organization", "person", "deal", "activity", "note"].map((entity) => ({
    name: `create_${entity}`, title: `Create Pipedrive ${entity}`,
    description: `Create one ${entity} in the connected user's Pipedrive account. Confirm the intended fields with the user first.`,
    inputSchema: { type: "object", properties: { fields: { type: "object", minProperties: 1, additionalProperties: true } }, required: ["fields"], additionalProperties: false },
    annotations: annotations(false),
  })),
  ...["organization", "person", "deal", "activity"].map((entity) => ({
    name: `update_${entity}`, title: `Update Pipedrive ${entity}`,
    description: `Update selected fields on one existing ${entity}. Retrieve or verify the record first and confirm material changes with the user.`,
    inputSchema: { type: "object", properties: { id: stringId, fields: { type: "object", minProperties: 1, additionalProperties: true } }, required: ["id", "fields"], additionalProperties: false },
    annotations: annotations(false),
  })),
  ...["organization", "person", "deal", "activity", "note"].map((entity) => ({
    name: `delete_${entity}`, title: `Delete Pipedrive ${entity}`,
    description: `Permanently delete one ${entity}. Use only when the user explicitly requests deletion and confirms the exact record ID.`,
    inputSchema: { type: "object", properties: { id: stringId }, required: ["id"], additionalProperties: false },
    annotations: destructiveAnnotations,
  })),
];

const plural = { organization: "organizations", person: "persons", deal: "deals", activity: "activities", note: "notes" };

export async function callTool(name, args, context) {
  const { pipedrive, accountId, scopes, db } = context;
  if (name === "pipedrive_profile") {
    const account = db.prepare("SELECT id, company_id, user_id, display_name, email, api_domain FROM pipedrive_accounts WHERE id = ?").get(accountId);
    if (!account) throw new Error("Pipedrive account is no longer connected");
    return result({ id: account.id, company_id: account.company_id, user_id: account.user_id, name: account.display_name, email: account.email, api_domain: account.api_domain }, "Connected Pipedrive profile.");
  }
  const searchMatch = /^search_(organizations|persons|deals)$/.exec(name);
  if (searchMatch) {
    requireScope(scopes, "pipedrive:read");
    const term = String(args.term || "").trim();
    if (term.length < 2) throw new Error("Search term must contain at least 2 characters");
    const limit = Math.min(Math.max(Number(args.limit || 20), 1), 50);
    const payload = await pipedrive.request(accountId, "GET", `/api/v1/${searchMatch[1]}/search?term=${encodeURIComponent(term)}&limit=${limit}`);
    return result({ items: payload.data?.items || [], additional_data: payload.additional_data || null }, `Found ${payload.data?.items?.length || 0} matching ${searchMatch[1]}.`);
  }
  if (name === "get_deal") {
    requireScope(scopes, "pipedrive:read");
    const payload = await pipedrive.request(accountId, "GET", `/api/v1/deals/${encodeURIComponent(args.id)}`);
    return result({ deal: payload.data }, "Retrieved the deal.");
  }
  const createMatch = /^create_(organization|person|deal|activity|note)$/.exec(name);
  if (createMatch) {
    requireScope(scopes, "pipedrive:write");
    assertFields(args.fields);
    const payload = await pipedrive.request(accountId, "POST", `/api/v1/${plural[createMatch[1]]}`, args.fields);
    return result({ record: payload.data }, `Created the ${createMatch[1]}.`);
  }
  const updateMatch = /^update_(organization|person|deal|activity)$/.exec(name);
  if (updateMatch) {
    requireScope(scopes, "pipedrive:write");
    assertFields(args.fields);
    const payload = await pipedrive.request(accountId, "PUT", `/api/v1/${plural[updateMatch[1]]}/${encodeURIComponent(args.id)}`, args.fields);
    return result({ record: payload.data }, `Updated the ${updateMatch[1]}.`);
  }
  const deleteMatch = /^delete_(organization|person|deal|activity|note)$/.exec(name);
  if (deleteMatch) {
    requireScope(scopes, "pipedrive:write");
    const payload = await pipedrive.request(accountId, "DELETE", `/api/v1/${plural[deleteMatch[1]]}/${encodeURIComponent(args.id)}`);
    return result({ deleted: payload.data ?? { id: args.id } }, `Deleted the ${deleteMatch[1]}.`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function assertFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
    throw new Error("fields must be a non-empty object");
  }
  for (const key of Object.keys(fields)) {
    if (key === "api_token" || key === "access_token" || key === "refresh_token") throw new Error("Credential fields are not allowed");
  }
}

function requireScope(scopes, required) {
  if (!scopes.includes(required)) throw new Error(`Connection lacks required scope: ${required}`);
}

function result(structuredContent, text) {
  return { structuredContent, content: [{ type: "text", text }] };
}
