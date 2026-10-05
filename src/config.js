export function loadConfig(env = process.env) {
  const required = ["BASE_URL", "TOKEN_ENCRYPTION_KEY", "PIPEDRIVE_CLIENT_ID", "PIPEDRIVE_CLIENT_SECRET"];
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  const baseUrl = env.BASE_URL.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://") && env.NODE_ENV === "production") {
    throw new Error("BASE_URL must use HTTPS in production");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.TOKEN_ENCRYPTION_KEY)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters");
  }
  return {
    baseUrl,
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || "./data/pipedrive-connector.sqlite",
    encryptionKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex"),
    pipedriveClientId: env.PIPEDRIVE_CLIENT_ID,
    pipedriveClientSecret: env.PIPEDRIVE_CLIENT_SECRET,
    accessTokenTtl: Number(env.ACCESS_TOKEN_TTL_SECONDS || 3600),
    allowedEmailDomain: env.ALLOWED_EMAIL_DOMAIN?.toLowerCase() || null,
  };
}
