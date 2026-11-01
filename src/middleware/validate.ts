import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodError, type ZodType } from "zod";
import { isValidObjectId } from "../utils/objectId.js";
import { sendError, sendInvalidId } from "../utils/httpResponse.js";

/**
 * Centralized Zod validation for incoming requests.
 *
 * - `validateBody(schema)`  — route middleware that parses `req.body`,
 *   answers 400 with a `field → messages[]` map on failure, and REPLACES
 *   `req.body` with the parsed (and therefore STRIPPED) payload. Because
 *   Zod drops unknown keys by default, ownership/identity fields a client
 *   sends (`addedBy`, `userEmail`, `createdAt`, …) are discarded here and
 *   can never reach a controller.
 * - `validateObjectId(resource)` — route middleware for `:id` params so a
 *   malformed ObjectId is a clean 400 instead of a database round-trip.
 *
 * Both run AFTER `requireAuth`, preserving the established order of
 * responses: 401 (auth) → 400 (bad id / bad body) → 404 → 403.
 */

/** Groups Zod issues into a `field → messages[]` map for the 400 response. */
export const formatZodIssues = (
  error: ZodError
): Record<string, string[]> => {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
};

/** Sends the standard validation-failure envelope (400 + per-field errors). */
export const sendValidationErrors = (
  res: Response,
  error: ZodError
): void => {
  sendError(
    res,
    400,
    "Validation failed. Please fix the highlighted fields.",
    formatZodIssues(error)
  );
};

/** Body-parsing/validating middleware factory. */
export const validateBody =
  (schema: ZodType): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationErrors(res, parsed.error);
      return;
    }
    // Store the SANITIZED payload: unknown keys are gone, so no controller
    // can read a client-supplied ownership/identity field by accident.
    req.body = parsed.data;
    next();
  };

/**
 * `:id` route-param guard: rejects anything that is not a 24-hex-char
 * MongoDB ObjectId with the API's standard 400 BEFORE any query runs.
 */
export const validateObjectId =
  (resource: "book" | "borrow"): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    const id = req.params.id;
    if (typeof id !== "string" || !isValidObjectId(id)) {
      sendInvalidId(res, resource);
      return;
    }
    next();
  };
