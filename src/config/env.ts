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
  /** Database name shared with the Next.js frontend (Better Auth collections live here). */
  DB_NAME: string;
  CORS_ORIGIN: string;
  /**
   * The Better Auth signing secret — MUST be byte-identical to the
   * `BETTER_AUTH_SECRET` used by the frontend, because session cookies
   * are HMAC-SHA256 signed with it.
   */
  BETTER_AUTH_SECRET: string;
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

const dbName = process.env.DB_NAME ?? "booknook";

const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (!betterAuthSecret) {
  missing.push("BETTER_AUTH_SECRET");
} else if (betterAuthSecret.length < 32) {
  throw new Error(
    "BETTER_AUTH_SECRET must be at least 32 characters long. " +
      "Use the exact same secret as the frontend (BETTER_AUTH_SECRET in the Next.js .env.local)."
  );
}

const corsOrigin =
  process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL ?? "http://localhost:3000";

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
  BETTER_AUTH_SECRET: betterAuthSecret as string,
};
