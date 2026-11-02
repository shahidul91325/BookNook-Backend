import type { Express, Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logError, logInfo } from "../utils/logger.js";
import createApp from "../app.js";
import { connectDB } from "../config/db.js";

/**
 * Vercel serverless entry point for the BookNook Express API.
 *
 * Unlike `src/server.ts` (which calls `app.listen()` for a persistent
 * dev/production server), this module never starts a listening server.
 * It creates the Express app once per cold start, caches it in module
 * scope, and reuses the MongoDB client cached by `src/config/db.ts`
 * across warm invocations — the safe pattern for serverless.
 *
 * The Express app is a plain request handler `(req, res) => void`, so it
 * can be invoked directly by the Vercel Node.js runtime without `listen()`.
 *
 * Health-check paths (`/` and `/api/health`) are answered directly without
 * waiting for MongoDB so that the API is never completely unreachable even
 * when the database is slow or temporarily unavailable.
 */

/** Max time (ms) to wait for app initialisation before answering 503.
 *  Set below Vercel's default 10s function timeout so we always send a
 *  response before the edge cuts the connection. */
const INIT_TIMEOUT_MS = 8_000;

/** Paths that do not require MongoDB and can be answered immediately.
 *  These respond with static data without touching the database, so they
 *  never hang even when MongoDB is slow or unreachable. */
const FAST_PATHS = ["/", "/api/health", "/api/testimonials"];

/** Lazily-created, cached Express app bound to a (reused) MongoDB client. */
let appPromise: Promise<Express> | null = null;

const getApp = async (): Promise<Express> => {
  if (!appPromise) {
    appPromise = connectDB()
      .then((db) => createApp(db))
      .catch((error) => {
        // Reset so the next invocation can retry instead of re-throwing a
        // cached rejection forever.
        appPromise = null;
        throw error;
      });
  }
  return appPromise;
};

/** Wraps a promise so it rejects with a timeout error after `ms` ms. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Sends a JSON response using native http.ServerResponse methods. */
const sendJson = (
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Vercel Node.js handler. Vercel passes raw `http.IncomingMessage` /
 * `http.ServerResponse`; Express consumes them directly.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "";

  // ── Fast path: static answers immediately, no MongoDB needed ───────────
  if (FAST_PATHS.includes(url)) {
    logInfo(`fast path: ${url}`);
    sendJson(res, 200, {
      status: "success",
      message: "BookNook API is running",
      environment: process.env.NODE_ENV ?? "production",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // ── All other routes require MongoDB-backed Express app ─────────────────
  try {
    logInfo(`request: ${url}`);
    const app = await withTimeout(getApp(), INIT_TIMEOUT_MS);
    app(req as Request, res as Response);
  } catch (error) {
    // Always answer the client — an indefinite hang is worse than a 503.
    // Use native http.ServerResponse methods because Express never patched
    // `res` when getApp() failed before app(req, res) was called.
    if (!res.headersSent) {
      logError("handler", error);
      sendJson(res, 503, {
        status: "error",
        message: "Service temporarily unavailable. Please try again later.",
      });
    }
  }
}
