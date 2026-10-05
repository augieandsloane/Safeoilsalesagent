import { decryptJson, encryptJson } from "./security.js";

export class PipedriveClient {
  constructor(config, db, fetchImpl = fetch) {
    this.config = config;
    this.db = db;
    this.fetch = fetchImpl;
  }

  async exchangeCode(code) {
    return this.#tokenRequest({ grant_type: "authorization_code", code, redirect_uri: `${this.config.baseUrl}/oauth/pipedrive/callback` });
  }

  async #tokenRequest(body) {
    const response = await this.fetch("https://oauth.pipedrive.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.config.pipedriveClientId}:${this.config.pipedriveClientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(body),
    });
    if (!response.ok) throw new Error(`Pipedrive token exchange failed (${response.status})`);
    return response.json();
  }

  async saveAccount(tokens) {
    const me = await this.rawRequest(tokens.api_domain, tokens.access_token, "GET", "/api/v1/users/me");
    const user = me.data;
    if (!user?.id || !user?.company_id) throw new Error("Pipedrive user profile was incomplete");
    if (this.config.allowedEmailDomain && !user.email?.toLowerCase().endsWith(`@${this.config.allowedEmailDomain}`)) {
      throw new Error("This Pipedrive user is not in the allowed email domain");
    }
    const id = `${user.company_id}:${user.id}`;
    const encrypted = encryptJson({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, this.config.encryptionKey);
    this.db.prepare(`INSERT INTO pipedrive_accounts
      (id, company_id, user_id, display_name, email, api_domain, encrypted_tokens, token_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, user_id) DO UPDATE SET display_name=excluded.display_name,
      email=excluded.email, api_domain=excluded.api_domain, encrypted_tokens=excluded.encrypted_tokens,
      token_expires_at=excluded.token_expires_at, updated_at=excluded.updated_at`).run(
      id, String(user.company_id), String(user.id), user.name || user.email || "Pipedrive user", user.email || null,
      tokens.api_domain, encrypted, Date.now() + Number(tokens.expires_in) * 1000, Date.now()
    );
    return { id, displayName: user.name || user.email || "Pipedrive user", email: user.email || null };
  }

  async request(accountId, method, path, body) {
    let account = this.db.prepare("SELECT * FROM pipedrive_accounts WHERE id = ?").get(accountId);
    if (!account) throw new Error("Pipedrive account is no longer connected");
    let tokens = decryptJson(account.encrypted_tokens, this.config.encryptionKey);
    if (account.token_expires_at < Date.now() + 60_000) {
      const refreshed = await this.#tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      await this.saveAccount(refreshed);
      account = this.db.prepare("SELECT * FROM pipedrive_accounts WHERE id = ?").get(accountId);
      tokens = decryptJson(account.encrypted_tokens, this.config.encryptionKey);
    }
    return this.rawRequest(account.api_domain, tokens.access_token, method, path, body);
  }

  async rawRequest(apiDomain, accessToken, method, path, body) {
    const response = await this.fetch(`${apiDomain}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const message = payload.error || payload.error_info || `Pipedrive request failed (${response.status})`;
      const error = new Error(String(message));
      error.status = response.status;
      throw error;
    }
    return payload;
  }
}
