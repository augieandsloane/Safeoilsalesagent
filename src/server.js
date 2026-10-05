import { createServer } from "node:http";
import { cleanup, openDatabase } from "./db.js";
import { loadConfig } from "./config.js";
import { PipedriveClient } from "./pipedrive.js";
import { callTool, toolDefinitions } from "./tools.js";
import { pkceChallenge, randomToken, safeEqual, sha256 } from "./security.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const pipedrive = new PipedriveClient(config, db);
const supportedScopes = ["pipedrive:read", "pipedrive:write"];
setInterval(() => cleanup(db), 10 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.baseUrl);
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") return protectedResource(res);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return authorizationMetadata(res);
    if (req.method === "POST" && url.pathname === "/oauth/register") return await registerClient(req, res);
    if (req.method === "GET" && url.pathname === "/oauth/authorize") return authorize(url, res);
    if (req.method === "GET" && url.pathname === "/oauth/pipedrive/callback") return await pipedriveCallback(url, res);
    if (req.method === "POST" && url.pathname === "/oauth/token") return await tokenEndpoint(req, res);
    if (url.pathname === "/mcp" && req.method === "POST") return await mcp(req, res);
    if (url.pathname === "/mcp" && (req.method === "GET" || req.method === "DELETE")) return json(res, 405, { error: "Stateless MCP endpoint accepts POST only" });
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: error.message, status: error.status || 500 }));
    return json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});

function protectedResource(res) {
  return json(res, 200, {
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [config.baseUrl],
    scopes_supported: supportedScopes,
    resource_documentation: `${config.baseUrl}/healthz`,
  });
}

function authorizationMetadata(res) {
  return json(res, 200, {
    issuer: config.baseUrl,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: supportedScopes,
  });
}

async function registerClient(req, res) {
  const body = await readJson(req);
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isAllowedRedirect)) {
    return json(res, 400, { error: "invalid_redirect_uri" });
  }
  const clientId = randomToken(24);
  const clientSecret = randomToken(32);
  db.prepare("INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .run(clientId, sha256(clientSecret), JSON.stringify(redirectUris), Date.now());
  return json(res, 201, {
    client_id: clientId, client_secret: clientSecret, client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "client_secret_basic", redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  });
}

function authorize(url, res) {
  const q = Object.fromEntries(url.searchParams);
  const client = db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(q.client_id);
  const scopes = String(q.scope || "pipedrive:read pipedrive:write").split(/\s+/).filter(Boolean);
  if (!client || !JSON.parse(client.redirect_uris).includes(q.redirect_uri)) return oauthError(res, q.redirect_uri, q.state, "invalid_request");
  if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) return oauthError(res, q.redirect_uri, q.state, "invalid_request");
  if (q.resource !== `${config.baseUrl}/mcp` || scopes.some((scope) => !supportedScopes.includes(scope))) return oauthError(res, q.redirect_uri, q.state, "invalid_scope");
  const internalState = randomToken();
  db.prepare("INSERT INTO auth_requests (state, payload, expires_at) VALUES (?, ?, ?)").run(internalState, JSON.stringify({ ...q, scope: scopes.join(" ") }), Date.now() + 10 * 60 * 1000);
  const target = new URL("https://oauth.pipedrive.com/oauth/authorize");
  target.searchParams.set("client_id", config.pipedriveClientId);
  target.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/pipedrive/callback`);
  target.searchParams.set("state", internalState);
  return redirect(res, target.toString());
}

async function pipedriveCallback(url, res) {
  const state = url.searchParams.get("state");
  const row = db.prepare("SELECT * FROM auth_requests WHERE state = ? AND expires_at > ?").get(state, Date.now());
  if (!row) return text(res, 400, "Authorization request expired. Return to ChatGPT and connect again.");
  db.prepare("DELETE FROM auth_requests WHERE state = ?").run(state);
  const request = JSON.parse(row.payload);
  if (url.searchParams.get("error")) return oauthError(res, request.redirect_uri, request.state, "access_denied");
  const tokens = await pipedrive.exchangeCode(url.searchParams.get("code"));
  const account = await pipedrive.saveAccount(tokens);
  const code = randomToken(32);
  db.prepare(`INSERT INTO oauth_codes
    (code_hash, client_id, redirect_uri, account_id, resource, scope, code_challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), request.client_id, request.redirect_uri, account.id, request.resource, request.scope, request.code_challenge, Date.now() + 5 * 60 * 1000);
  const target = new URL(request.redirect_uri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", request.state || "");
  target.searchParams.set("iss", config.baseUrl);
  return redirect(res, target.toString());
}

async function tokenEndpoint(req, res) {
  const body = Object.fromEntries(new URLSearchParams((await readBody(req)).toString("utf8")));
  const auth = parseClientAuth(req, body);
  const client = db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(auth.clientId);
  if (!client || !safeEqual(client.client_secret_hash, sha256(auth.clientSecret))) return json(res, 401, { error: "invalid_client" });
  if (body.grant_type === "authorization_code") {
    const code = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ? AND expires_at > ?").get(sha256(body.code || ""), Date.now());
    if (!code || code.client_id !== auth.clientId || code.redirect_uri !== body.redirect_uri || pkceChallenge(body.code_verifier || "") !== code.code_challenge) return json(res, 400, { error: "invalid_grant" });
    db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(code.code_hash);
    return issueTokens(res, code);
  }
  if (body.grant_type === "refresh_token") {
    const row = db.prepare("SELECT * FROM connector_tokens WHERE refresh_hash = ? AND refresh_expires_at > ?").get(sha256(body.refresh_token || ""), Date.now());
    if (!row || row.client_id !== auth.clientId) return json(res, 400, { error: "invalid_grant" });
    db.prepare("DELETE FROM connector_tokens WHERE refresh_hash = ?").run(row.refresh_hash);
    return issueTokens(res, row);
  }
  return json(res, 400, { error: "unsupported_grant_type" });
}

function issueTokens(res, grant) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(40);
  const now = Date.now();
  db.prepare(`INSERT INTO connector_tokens
    (access_hash, refresh_hash, client_id, account_id, resource, scope, access_expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(accessToken), sha256(refreshToken), grant.client_id, grant.account_id, grant.resource, grant.scope, now + config.accessTokenTtl * 1000, now + 30 * 24 * 3600 * 1000);
  return json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: config.accessTokenTtl, refresh_token: refreshToken, scope: grant.scope });
}

async function mcp(req, res) {
  const auth = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
  const token = auth && db.prepare("SELECT * FROM connector_tokens WHERE access_hash = ? AND access_expires_at > ?").get(sha256(auth[1]), Date.now());
  if (!token) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource", scope="pipedrive:read pipedrive:write"`);
    return json(res, 401, { error: "unauthorized" });
  }
  const rpc = await readJson(req);
  if (!Object.hasOwn(rpc, "id")) return empty(res, 202);
  if (rpc.method === "initialize") return rpcResult(res, rpc.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "safe-oil-pipedrive", version: "1.0.0" }, instructions: "Use read tools for discovery. Before any write, verify the target record and confirm the intended change. Never expose credentials." });
  if (rpc.method === "ping") return rpcResult(res, rpc.id, {});
  if (rpc.method === "tools/list") return rpcResult(res, rpc.id, { tools: toolDefinitions });
  if (rpc.method === "tools/call") {
    try {
      const result = await callTool(rpc.params?.name, rpc.params?.arguments || {}, { pipedrive, accountId: token.account_id, scopes: token.scope.split(" "), db });
      return rpcResult(res, rpc.id, result);
    } catch (error) {
      return rpcResult(res, rpc.id, { isError: true, content: [{ type: "text", text: error.message }] });
    }
  }
  return rpcError(res, rpc.id, -32601, "Method not found");
}

function parseClientAuth(req, body) {
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization || "");
  if (basic) {
    const [clientId, clientSecret] = Buffer.from(basic[1], "base64").toString("utf8").split(":", 2);
    return { clientId, clientSecret };
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

function isAllowedRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com"));
  } catch { return false; }
}

function oauthError(res, redirectUri, state, error) {
  if (!isAllowedRedirect(redirectUri)) return json(res, 400, { error });
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", config.baseUrl);
  return redirect(res, url.toString());
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) { const error = new Error("Request body too large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) { return JSON.parse((await readBody(req)).toString("utf8") || "{}"); }
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function text(res, status, value) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(value); }
function empty(res, status) { res.writeHead(status); res.end(); }
function redirect(res, location) { res.writeHead(302, { location, "cache-control": "no-store" }); res.end(); }
function rpcResult(res, id, result) { return json(res, 200, { jsonrpc: "2.0", id, result }); }
function rpcError(res, id, code, message) { return json(res, 200, { jsonrpc: "2.0", id, error: { code, message } }); }

server.listen(config.port, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", message: "connector listening", port: config.port })));
