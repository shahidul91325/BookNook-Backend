/**
 * Role-based authorization middleware for the BookNook API.
 *
 * `requireAdmin` asserts that the verified caller has the `admin` role.
 * It must be used AFTER `requireAuth`, which populates `req.auth` from a
 * cryptographically verified session or JWT. The role is read exclusively
 * from `req.auth.user.role` — never from client-supplied headers, body, or
 * query parameters.
 *
 * On failure it responds with 403 { "status": "fail", "message": "…" }.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendError } from "../utils/httpResponse.js";

/**
 * Creates the admin authorization middleware.
 *
 * @example
 * app.post("/api/books", requireAuth, requireAdmin, createCreateBook(db));
 */
export const createRequireAdmin = (): RequestHandler =>
  (_req: Request, res: Response, next: NextFunction): void => {
    const auth = _req.auth;
    if (!auth || auth.user.role !== "admin") {
      sendError(
        res,
        403,
        "Admin access required. You do not have permission to perform this action."
      );
      return;
    }
    next();
  };
