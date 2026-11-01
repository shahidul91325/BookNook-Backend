import type { Response } from "express";

/**
 * The single place that knows the BookNook response envelope.
 *
 * Success:  { "status": "success", ...payload }
 * Failure:  { "status": "fail",    "message": "…" }      (4xx)
 * Error:    { "status": "error",   "message": "…" }      (5xx)
 *
 * Every controller and middleware goes through these helpers, so the shape
 * can never drift between endpoints and no handler can accidentally leak
 * extra fields (stack traces, internal messages, …).
 */

/** Sends a success envelope with an arbitrary payload (data, lists, …). */
export const sendSuccess = (
  res: Response,
  payload: Record<string, unknown>,
  statusCode = 200
): void => {
  res.status(statusCode).json({ status: "success", ...payload });
};

/**
 * Sends the standard failure envelope. 5xx responses use `status: "error"`
 * (matching the pre-Phase-8 contract), everything below uses `"fail"`.
 */
export const sendError = (
  res: Response,
  statusCode: number,
  message: string,
  errors?: Record<string, string[]>
): void => {
  res.status(statusCode).json({
    status: statusCode >= 500 ? "error" : "fail",
    message,
    ...(errors ? { errors } : {}),
  });
};

/** Sends the standard 404 envelope. */
export const sendNotFound = (
  res: Response,
  message = "Resource not found."
): void => {
  sendError(res, 404, message);
};

/**
 * Sends the standard 400 for a malformed MongoDB ObjectId route param.
 * The wording is identical to the pre-Phase-8 responses, so the API
 * contract for invalid ids is unchanged.
 */
export const sendInvalidId = (
  res: Response,
  resource: "book" | "borrow"
): void => {
  sendError(
    res,
    400,
    `Invalid ${resource} id. Expected a 24-character MongoDB ObjectId.`
  );
};
