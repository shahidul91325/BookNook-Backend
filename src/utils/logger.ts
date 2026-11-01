/**
 * Safe server-side logging.
 *
 * Rule: logs may contain anything EXCEPT secrets. Error messages produced
 * by drivers/config loaders sometimes embed connection strings (with
 * credentials) or tokens, so every message is scrubbed before printing.
 * Request bodies, cookies, and Authorization headers are NEVER logged.
 *
 * Stack traces are written to the server log only — they are never placed
 * in an HTTP response (see `src/middleware/errorHandler.ts`).
 */

/** `mongodb://user:password@host` / `mongodb+srv://user:pass@host` → creds redacted. */
const MONGO_URI_CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)[^\s@/]+:[^\s@/]*@/g;
/** `Bearer eyJhbGciOi…` → token redacted. */
const BEARER_TOKEN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `SECRET=value`, `password: value`, `BETTER_AUTH_TOKEN=…` → value redacted. */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:secret|password|passwd|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s"']+/gi;

/** Removes credential-like values from a free-form log string. */
export const sanitizeLogText = (text: string): string =>
  text
    .replace(MONGO_URI_CREDENTIALS, "$1***:***@")
    .replace(BEARER_TOKEN, "$1***")
    .replace(SECRET_ASSIGNMENT, "$1***");

/**
 * Logs an error with secrets scrubbed. The stack (also scrubbed) goes to
 * the log only — responses stay generic regardless of environment.
 */
export const logError = (scope: string, error: unknown): void => {
  if (error instanceof Error) {
    const head = `${scope}: ${error.name}: ${sanitizeLogText(error.message)}`;
    const stack = error.stack ? `\n${sanitizeLogText(error.stack)}` : "";
    console.error(`${head}${stack}`);
    return;
  }
  console.error(`${scope}: ${sanitizeLogText(String(error))}`);
};

/** Logs a startup/operational notice (still scrubbed, never secret values). */
export const logInfo = (message: string): void => {
  console.log(sanitizeLogText(message));
};
