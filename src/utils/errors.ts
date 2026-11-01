/**
 * Central error taxonomy for the BookNook API.
 *
 * Every error that carries a CLIENT-SAFE message and an HTTP status code
 * extends `ApiError`. The centralized error handler (see
 * `src/middleware/errorHandler.ts`) recognizes it and responds with exactly
 * that status + message — anything else falls through to a generic 500 so
 * internal details (stack traces, MongoDB messages, connection strings)
 * can never reach a client.
 */

/** An error whose message is safe to send to the client as-is. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

/**
 * Domain outcome of an inventory operation (borrow/return) that maps to a
 * specific HTTP status — e.g. 409 when no copies are available. Kept as a
 * distinct subclass so logs remain easy to grep.
 */
export class OperationError extends ApiError {
  constructor(statusCode: number, message: string) {
    super(statusCode, message);
    this.name = "OperationError";
  }
}
