import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "mongodb";
import { authenticateRequest } from "../services/auth.service.js";
import type { AuthenticatedContext } from "../types/auth.js";
import { sendError } from "../utils/httpResponse.js";
import { logError } from "../utils/logger.js";
import { createRequireAdmin } from "./admin.js";

/**
 * Reusable authentication/authorization middleware for the BookNook API.
 *
 * `requireAuth` establishes request identity EXCLUSIVELY from a
 * cryptographically verified Better Auth session (HMAC-checked cookie or
 * bearer value + authoritative lookup in the `session` collection).
 * Client-supplied `userId` / `email` / ownership fields in the body,
 * query, or headers are NEVER read to determine who the caller is.
 *
 * On success it sets `req.auth` (see `src/types/auth.ts`) and calls
 * `next()`. On failure it responds with a consistent JSON error shape:
 *
 *   401 { "status": "fail", "message": "…" }   — no/invalid/expired credentials
 *   403 { "status": "fail", "message": "…" }   — authenticated but not allowed
 */

/** Sends the consistent 401 response used by every authentication failure. */
export const sendUnauthorized = (res: Response): void => {
  sendError(
    res,
    401,
    "Authentication required. Please sign in and try again."
  );
};

/** Sends the consistent 403 response used by every authorization failure. */
export const sendForbidden = (res: Response, message?: string): void => {
  sendError(
    res,
    403,
    message ?? "You do not have permission to perform this action."
  );
};

/**
 * Defensive guard for authenticated controllers: returns the verified
 * context, or answers 401 and returns `null` if the route was somehow
 * reached without `requireAuth`. Controllers use it as the FIRST step:
 *
 *   const auth = requireAuthContext(req, res);
 *   if (!auth) return;
 */
export const requireAuthContext = (
  req: Request,
  res: Response
): AuthenticatedContext | null => {
  const auth = req.auth;
  if (!auth) {
    sendUnauthorized(res);
    return null;
  }
  return auth;
};

/**
 * Creates the authentication middleware bound to a database handle.
 *
 * Accepts credentials from (in order):
 *   1. The `better-auth.session_token` cookie (HMAC signature required).
 *   2. An `Authorization: Bearer <token>` header (signed or bare opaque
 *      session token — same rules as Better Auth's `bearer()` plugin).
 */
export const createRequireAuth =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await authenticateRequest(
        db,
        req.headers.cookie,
        req.headers.authorization
      );

      if (!context) {
        sendUnauthorized(res);
        return;
      }

      req.auth = context;
      next();
    } catch (error) {
      // Never leak internals on the auth path; treat unexpected errors as
      // failed authentication rather than letting the request proceed.
      logError("auth", error);
      sendUnauthorized(res);
    }
  };

/**
 * Authorization helper: asserts the verified user owns the resource.
 * Use AFTER `requireAuth`, passing the owner id resolved server-side
 * (e.g. from the database document — never from the request body).
 *
 * @example
 * app.put("/api/books/:id", requireAuth, async (req, res) => {
 *   const book = await bookRepository.findBookById(req.params.id);
 *   if (!book) return sendNotFound(res);
 *   if (book.addedBy !== req.auth!.user.id) return sendForbidden(res);
 *   // …
 * });
 */
export const isOwner = (req: Request, ownerId: string): boolean =>
  Boolean(req.auth && req.auth.user.id === ownerId);

/** Re-exported from `./admin.js` for convenient single-import usage. */
export { createRequireAdmin };
