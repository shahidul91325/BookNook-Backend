import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendError } from "../utils/httpResponse.js";

/**
 * Dependency-free in-memory sliding fixed-window rate limiter.
 *
 * Why in-memory: this API is a single Node process, and adding a Redis
 * dependency just for limiting would be disproportionate. The store is
 * per-process; if the API is ever scaled horizontally, move the buckets to
 * a shared store (e.g. Redis) at that point.
 *
 * Keys are scoped (`global`, `write`, …) and derived from the client IP
 * (`req.ip`, which respects the `trust proxy` setting). Buckets expire
 * automatically, so memory stays bounded even under an IP flood.
 *
 * Blocked requests receive the standard failure envelope with 429 and a
 * `Retry-After` header (seconds until the window resets).
 */

export type RateLimitOptions = {
  /** Namespace for the bucket key, so different limiters never collide. */
  scope: string;
  /** Length of the counting window, in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per client per window. */
  max: number;
  /** Optional custom message for the 429 response. */
  message?: string;
};

type Bucket = { count: number; resetAt: number };

const MAX_TRACKED_CLIENTS = 10_000;

const DEFAULT_MESSAGE =
  "Too many requests. Please slow down and try again shortly.";

export const createRateLimit = (options: RateLimitOptions): RequestHandler => {
  const { scope, windowMs, max, message = DEFAULT_MESSAGE } = options;
  const buckets = new Map<string, Bucket>();

  // Periodic sweep so expired buckets (and a flood of one-shot IPs) never
  // accumulate. `unref()` keeps the timer from holding the process open.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${scope}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Bound memory: if a flood filled the map, drop expired entries first.
      if (buckets.size >= MAX_TRACKED_CLIENTS) {
        for (const [k, v] of buckets) {
          if (v.resetAt <= now) buckets.delete(k);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      sendError(res, 429, message);
      return;
    }

    next();
  };
};
