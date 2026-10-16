import { parseDomainAllowlist } from "./policy.js";

export interface AppConfig {
  apiToken: string;
  allowedDomains: Set<string>;
  databaseUrl: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const apiToken = env.API_TOKEN;
  if (!apiToken || Buffer.byteLength(apiToken) < 32) {
    throw new Error("API_TOKEN must contain at least 32 bytes");
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    apiToken,
    allowedDomains: parseDomainAllowlist(env.ALLOWED_DOMAINS),
    databaseUrl: env.DATABASE_URL,
  };
}
