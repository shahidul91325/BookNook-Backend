import type { Express, Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
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
 */

/** Lazily-created, cached Express app bound to a (reused) MongoDB client. */
let appPromise: Promise<Express> | null = null;

const getApp = async (): Promise<Express> => {
  if (!appPromise) {
    appPromise = connectDB().then((db) => createApp(db));
  }
  return appPromise;
};

/**
 * Vercel Node.js handler. Vercel passes raw `http.IncomingMessage` /
 * `http.ServerResponse`; Express consumes them directly.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const app = await getApp();
  app(req as Request, res as Response);
}
