import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY, client_secret_hash TEXT NOT NULL,
      redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_requests (
      state TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipedrive_accounts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, user_id TEXT NOT NULL,
      display_name TEXT NOT NULL, email TEXT, api_domain TEXT NOT NULL,
      encrypted_tokens TEXT NOT NULL, token_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, UNIQUE(company_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      account_id TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_tokens (
      access_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL, account_id TEXT NOT NULL, resource TEXT NOT NULL,
      scope TEXT NOT NULL, access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function cleanup(db, now = Date.now()) {
  db.prepare("DELETE FROM auth_requests WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM connector_tokens WHERE refresh_expires_at < ?").run(now);
}
