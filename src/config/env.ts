import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the project root regardless of where the process was started
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export interface EnvConfig {
  NODE_ENV: "development" | "production" | "test";
  PORT: number;
  MONGODB_URI: string;
  /** Database used by the Express API and Better Auth adapter. */
  DB_NAME: string;
  /** Raw, comma-separated CORS origins as configured. */
  CORS_ORIGIN: string;
  /**
   * Parsed CORS allowlist. Only these exact origins receive CORS headers
   * (and therefore may call the API with credentials from a browser).
   * Wildcards are rejected at startup — see the validation below.
   */
  CORS_ORIGINS: string[];
  /**
   * The Better Auth signing secret used by the sole Express auth server.
   */
  BETTER_AUTH_SECRET: string;
  /** Frontend origin plus the /api/auth base path forwarded to Express. */
  BETTER_AUTH_URL: string;
  /** Optional direct URL to the Express JWT plugin's JWKS endpoint. */
  JWT_JWKS_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Rate limiting: length of one counting window, in milliseconds. */
  RATE_LIMIT_WINDOW_MS: number;
  /** Rate limiting: max requests per client per window (all endpoints). */
  RATE_LIMIT_MAX: number;
  /** Rate limiting: max write requests (create/update/delete/borrow/return). */
  RATE_LIMIT_WRITE_MAX: number;
  /**
   * Number of reverse proxies in front of the API (0 = none). Only enable
   * when the API is reached THROUGH a trusted proxy (nginx, load balancer);
   * otherwise clients could spoof `X-Forwarded-For` to dodge rate limits.
   */
  TRUST_PROXY: number;
  /** JWT issuer claim — must match the value Better Auth uses when issuing. */
  JWT_ISSUER: string;
  /** JWT audience claim — must match the value the API expects. */
  JWT_AUDIENCE: string;
}

const missing: string[] = [];

const nodeEnvRaw = process.env.NODE_ENV ?? "development";
if (nodeEnvRaw !== "development" && nodeEnvRaw !== "production" && nodeEnvRaw !== "test") {
  throw new Error(
    `Invalid NODE_ENV "${nodeEnvRaw}". Use "development", "production" or "test".`
  );
}

const portRaw = process.env.PORT ?? "5000";
const port = Number(portRaw);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT "${portRaw}". It must be an integer between 1 and 65535.`);
}

const mongodbUri = process.env.MONGODB_URI;
if (!mongodbUri) {
  missing.push("MONGODB_URI");
}

// MONGODB_DB_NAME is the documented name. Keep DB_NAME as a fallback for
// deployments created before the variable was standardized.
const dbName = process.env.MONGODB_DB_NAME ?? process.env.DB_NAME ?? "booknook";
if (!dbName.trim()) {
  throw new Error("MONGODB_DB_NAME must not be empty.");
}

const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (!betterAuthSecret) {
  missing.push("BETTER_AUTH_SECRET");
} else if (betterAuthSecret.length < 32) {
  throw new Error(
    "BETTER_AUTH_SECRET must be at least 32 characters long. " +
      "Keep this secret on the Express server only."
  );
}

const betterAuthUrl = process.env.BETTER_AUTH_URL;
if (!betterAuthUrl) missing.push("BETTER_AUTH_URL");
else if (!/^https?:\/\/[^\s]+\/api\/auth\/?$/i.test(betterAuthUrl)) {
  throw new Error("BETTER_AUTH_URL must be the frontend auth URL ending in /api/auth.");
}

const corsOrigin =
  process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL ?? "http://localhost:3000";

/**
 * Parse and harden the CORS allowlist.
 *
 * - Origins are exact matches (scheme + host + port); no wildcards, no
 *   pattern matching. `credentials: true` is enabled so the Better Auth
 *   session cookie can ride along, and a wildcard origin is both useless
 *   (browsers reject `*` with credentials) and dangerous — so `*` fails
 *   fast at startup instead of silently opening the API.
 * - `null`, empty entries, and non-http(s) schemes are rejected.
 */
const parseCorsOrigins = (raw: string): string[] => {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error(
      "CORS_ORIGIN is empty. List the frontend origin(s), e.g. " +
        "CORS_ORIGIN=http://localhost:3000 (comma separated for several)."
    );
  }

  for (const entry of entries) {
    if (entry === "*") {
      throw new Error(
        'CORS_ORIGIN must not contain "*" — credentials are enabled, and a ' +
          "wildcard would expose the API to every website. List explicit " +
          "origin(s) instead, e.g. CORS_ORIGIN=https://booknook.example.com"
      );
    }
    if (entry === "null" || !/^https?:\/\/[^/\s]+$/i.test(entry)) {
      throw new Error(
        `Invalid CORS_ORIGIN entry "${entry}". Each entry must be an http(s) ` +
          "origin like https://app.example.com (no trailing slash or path)."
      );
    }
  }

  return [...new Set(entries)];
};

const corsOrigins = parseCorsOrigins(corsOrigin);

/** Reads a positive-integer env override, falling back to a default. */
const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${raw}". It must be a positive integer.`);
  }
  return value;
};

const rateLimitWindowMs = readPositiveInt("RATE_LIMIT_WINDOW_MS", 60_000);
const rateLimitMax = readPositiveInt("RATE_LIMIT_MAX", 300);
const rateLimitWriteMax = readPositiveInt("RATE_LIMIT_WRITE_MAX", 60);

const trustProxyRaw = process.env.TRUST_PROXY ?? "0";
const trustProxy = trustProxyRaw === "true" ? 1 : Number(trustProxyRaw);
if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
  throw new Error(
    `Invalid TRUST_PROXY "${trustProxyRaw}". Use 0 (direct exposure, the ` +
      'safe default), "true", or the number of trusted proxy hops.'
  );
}

// The values below match the defaults the JWT plugin derives from baseURL.
const jwtIssuer = process.env.JWT_ISSUER ?? (betterAuthUrl as string);
const jwtAudience = process.env.JWT_AUDIENCE ?? (betterAuthUrl as string);

if (missing.length > 0) {
  // Fail fast and safely: never print secret values, only missing key names.
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Copy .env.example to .env and fill in the values.`
  );
}

export const env: EnvConfig = {
  NODE_ENV: nodeEnvRaw,
  PORT: port,
  MONGODB_URI: mongodbUri as string,
  DB_NAME: dbName,
  CORS_ORIGIN: corsOrigin,
  CORS_ORIGINS: corsOrigins,
  BETTER_AUTH_SECRET: betterAuthSecret as string,
  BETTER_AUTH_URL: betterAuthUrl as string,
  JWT_JWKS_URL:
    process.env.JWT_JWKS_URL ?? `${betterAuthUrl as string}/jwks`,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  RATE_LIMIT_WINDOW_MS: rateLimitWindowMs,
  RATE_LIMIT_MAX: rateLimitMax,
  RATE_LIMIT_WRITE_MAX: rateLimitWriteMax,
  TRUST_PROXY: trustProxy,
  JWT_ISSUER: jwtIssuer,
  JWT_AUDIENCE: jwtAudience,
};
