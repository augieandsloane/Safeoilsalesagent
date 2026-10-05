# Safe Oil Pipedrive connector for ChatGPT

This service is a multi-user OAuth bridge and MCP server for the Safe Oil Field Sales Coach. Each representative authorizes their own Pipedrive user. ChatGPT receives a connector token that resolves to exactly one encrypted Pipedrive credential set.

## Security model

- No shared Pipedrive API token.
- Pipedrive access and refresh tokens are encrypted with AES-256-GCM at rest.
- ChatGPT authorization uses OAuth authorization code flow with S256 PKCE.
- Connector access and refresh tokens are random, stored only as SHA-256 hashes, and rotated.
- Dynamic client registration accepts only HTTPS callbacks on `chatgpt.com`.
- Every MCP call is scoped to the Pipedrive account bound during authorization.
- Write tools require `pipedrive:write`; delete tools are explicitly marked destructive.
- Tool results never include credentials.

## Exposed tools

Read tools: profile, search organizations, search people, search deals, and retrieve a deal.

Write tools: create organizations, people, deals, activities, and notes; update organizations, people, deals, and activities; delete organizations, people, deals, activities, and notes. Write tools carry non-read-only annotations, and deletes carry destructive annotations so ChatGPT can require approval.

## 1. Register the Pipedrive app

In Pipedrive Developer Hub, create a private app for internal rollout (or a public app for distribution beyond your organization).

Set the OAuth callback URL to:

```text
https://YOUR-CONNECTOR-DOMAIN/oauth/pipedrive/callback
```

Enable only these access scopes:

- `base`
- `deals:full`
- `contacts:full`
- `activities:full`

Copy the client ID and client secret into your deployment secret manager. Do not put them in source control or ChatGPT messages.

## 2. Configure and deploy

The connector needs a stable public HTTPS domain. Copy `.env.example` to the host's secret configuration and set:

- `BASE_URL`: public origin only, without a trailing slash
- `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`: from Developer Hub
- `TOKEN_ENCRYPTION_KEY`: 32 random bytes represented as 64 hex characters
- `DATABASE_PATH`: persistent mounted path; default `/data/pipedrive-connector.sqlite`
- `ALLOWED_EMAIL_DOMAIN`: optional company-domain restriction

Generate the encryption key on a trusted machine:

```bash
openssl rand -hex 32
```

Run with Docker:

```bash
docker compose up -d --build
curl https://YOUR-CONNECTOR-DOMAIN/healthz
```

Back up the database volume and encryption key together. Losing the key makes stored Pipedrive tokens unrecoverable. Rotating it requires a planned re-encryption migration or having users reconnect.

## 3. Connect it to this ChatGPT agent

1. In ChatGPT, enable Developer mode under **Settings -> Security and login**.
2. Open **Plugins**, choose the plus button, and enter `https://YOUR-CONNECTOR-DOMAIN/mcp`.
3. Complete the plugin details and install it for the Safe Oil Field Sales Coach.
4. Invoke a Pipedrive tool. ChatGPT will open the authorization flow; the representative signs into Pipedrive and approves access.
5. Call `pipedrive_profile` and confirm that the displayed user/company is correct before any write.

For a workspace rollout, publish or share the plugin through the ChatGPT workspace after testing it with a limited group. Each user still completes their own Pipedrive authorization.

## Operational checks

```bash
npm test
docker compose config
```

Before rollout, test read operations, create/update operations in a Pipedrive sandbox, reconnect, token refresh, revocation, and a user from a disallowed email domain. Configure your HTTPS proxy to rate-limit `/oauth/register`, `/oauth/token`, and `/mcp`, cap request bodies, and redact authorization headers.

Pipedrive refresh tokens expire after 60 days of non-use. A rep whose connection remains unused that long must reconnect.
