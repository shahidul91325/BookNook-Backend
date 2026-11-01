import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../utils/errors.js";
import { sendError } from "../utils/httpResponse.js";
import { logError } from "../utils/logger.js";
import { formatZodIssues } from "./validate.js";

/**
 * Centralized 404 + error handling — the ONLY place outside controllers
 * that produces an HTTP failure response.
 *
 * Guarantees:
 *   - Every failure uses the standard envelope
 *     (`{ status, message[, errors] }`).
 *   - 500 responses are ALWAYS generic ("Something went wrong on the
 *     server") — no stack traces, no driver messages, no connection
 *     details, in every environment.
 *   - 4xx responses only carry messages the server itself authored
 *     (`ApiError`, Zod, or our own body-parser mapping).
 *   - Errors are logged server-side with secrets scrubbed.
 */

const INTERNAL_ERROR_MESSAGE = "Something went wrong on the server.";
const VALIDATION_MESSAGE = "Validation failed. Please fix the highlighted fields.";
const PAYLOAD_TOO_LARGE_MESSAGE =
  "Request body is too large. Please send a smaller payload.";
const INVALID_JSON_MESSAGE = "Invalid JSON payload. Please fix the request body.";
const UNSUPPORTED_ENCODING_MESSAGE =
  "Unsupported request body encoding. Use application/json.";
const ABORTED_REQUEST_MESSAGE = "Request aborted before it completed.";
const BAD_REQUEST_MESSAGE = "The request could not be processed.";
const DUPLICATE_BORROW_MESSAGE =
  "You already have this book borrowed. Return it before borrowing again.";
const DUPLICATE_RECORD_MESSAGE =
  "A conflicting record already exists. Please refresh and try again.";

/** Body-parser (`express.json()`) error kinds we map to friendly 4xxs. */
const BODY_PARSER_MESSAGES: Record<string, { status: number; message: string }> = {
  "entity.too.large": { status: 413, message: PAYLOAD_TOO_LARGE_MESSAGE },
  "entity.parse.failed": { status: 400, message: INVALID_JSON_MESSAGE },
  "encoding.unsupported": { status: 415, message: UNSUPPORTED_ENCODING_MESSAGE },
  "request.aborted": { status: 400, message: ABORTED_REQUEST_MESSAGE },
};

/**
 * MongoDB duplicate-key errors (E11000). Our only unique index is the
 * partial `borrows_one_active_per_user_book` (one active borrow per user
 * per book), so that index name maps to the friendly borrow message and
 * anything else gets a generic conflict message. The raw driver message
 * (which contains collection/index names) is NEVER sent to the client.
 */
const duplicateKeyStatus = (error: unknown): { status: number; message: string } | null => {
  const err = error as { code?: number; message?: string } | null;
  if (err?.code !== 11000) return null;
  return (err.message ?? "").includes("borrows_one_active_per_user_book")
    ? { status: 409, message: DUPLICATE_BORROW_MESSAGE }
    : { status: 409, message: DUPLICATE_RECORD_MESSAGE };
};

/** Catch-all 404 for unmatched method+path combinations. */
export const notFoundHandler: RequestHandler = (req: Request, res: Response) => {
  sendError(res, 404, `Route ${req.method} ${req.originalUrl} not found`);
};

/**
 * Express error-handling middleware (must keep its 4-arg signature).
 * Maps every thrown/rejected error onto the standard envelope.
 */
export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  // 1. Server-authored, client-safe errors (status + message chosen by us).
  if (error instanceof ApiError) {
    sendError(res, error.statusCode, error.message);
    return;
  }

  // 2. Zod failures that escaped the validation middleware (defense in depth).
  if (error instanceof ZodError) {
    sendError(res, 400, VALIDATION_MESSAGE, formatZodIssues(error));
    return;
  }

  // 3. Request problems (oversized body, malformed JSON, …) — mapped to
  //    friendly messages that never echo the client's payload back.
  const err = error as { type?: string; status?: number; statusCode?: number; expose?: boolean; message?: string } | null;
  const parser = err?.type ? BODY_PARSER_MESSAGES[err.type] : undefined;
  if (parser) {
    sendError(res, parser.status, parser.message);
    return;
  }

  // 4. Other client errors explicitly marked safe to expose by their author.
  const rawStatus = err?.status ?? err?.statusCode;
  if (
    typeof rawStatus === "number" &&
    rawStatus >= 400 &&
    rawStatus < 500 &&
    err?.expose === true &&
    typeof err.message === "string"
  ) {
    sendError(res, rawStatus, err.message);
    return;
  }

  // 5. MongoDB duplicate key → 409 (friendly message, no driver internals).
  const duplicate = duplicateKeyStatus(error);
  if (duplicate) {
    sendError(res, duplicate.status, duplicate.message);
    return;
  }

  // 6. Anything else is a bug on OUR side: generic 500 to the client,
  //    full (secret-scrubbed) detail to the server log only.
  logError("http", error);
  sendError(res, 500, INTERNAL_ERROR_MESSAGE);
};
