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
  /** Frontend origin derived from BETTER_AUTH_URL for CORS/trust checks. */
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

const dbName = process.env.MONGODB_DB_NAME ?? "booknook";
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
if (!betterAuthUrl) {
  missing.push("BETTER_AUTH_URL");
} else {
  try {
    const parsed = new URL(betterAuthUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname.replace(/\/+$/, "") !== "/api/auth" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "BETTER_AUTH_URL must be the public frontend URL including the auth path, " +
        "for example https://your-frontend.vercel.app/api/auth (no query or fragment)."
    );
  }
}

// CORS and Better Auth trust the same canonical frontend origin, avoiding a
// second environment variable that could drift from the auth URL.
const corsOrigins = betterAuthUrl ? [new URL(betterAuthUrl).origin] : [];

const jwtJwksUrl = process.env.JWT_JWKS_URL;
if (!jwtJwksUrl) {
  missing.push("JWT_JWKS_URL");
} else {
  try {
    const parsed = new URL(jwtJwksUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname.replace(/\/+$/, "") !== "/api/auth/jwks" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("JWT_JWKS_URL must be an http(s) Express URL ending in /api/auth/jwks.");
  }
}

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
  CORS_ORIGINS: corsOrigins,
  BETTER_AUTH_SECRET: betterAuthSecret as string,
  BETTER_AUTH_URL: betterAuthUrl as string,
  JWT_JWKS_URL: jwtJwksUrl as string,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  RATE_LIMIT_WINDOW_MS: rateLimitWindowMs,
  RATE_LIMIT_MAX: rateLimitMax,
  RATE_LIMIT_WRITE_MAX: rateLimitWriteMax,
  TRUST_PROXY: trustProxy,
};
