import express from "express";
import { connectDB } from "./src/config/db.js";
import { ensureIndexes } from "./src/config/indexes.js";
import createApp from "./src/app.js";
import { logError, logInfo } from "./src/utils/logger.js";

/**
 * Vercel native Express entry point.
 *
 * This module creates the Express application once per cold start and exports
 * it as the default export. Vercel detects the default Express export and
 * wraps it in a serverless function automatically — no `vercel.json`, no
 * `dist/server.js`, and no TypeScript compilation step are required for
 * deployment.
 *
 * The MongoDB client is connected once at module load (cold start) and reused
 * across warm invocations via module-level caching in `src/config/db.ts`.
 * Concurrent initialization attempts are deduplicated there as well.
 *
 * Local development uses `src/server.ts` (which calls `app.listen()`); this
 * file is the Vercel entry point and never calls `listen()`.
 */

let app: ReturnType<typeof createApp>;

try {
  // Top-level await: runs once per cold start, reused on warm starts.
  const db = await connectDB();
  await ensureIndexes(db);
  app = createApp(db);
  logInfo("✅ BookNook API initialized for Vercel");
} catch (error) {
  // If DB/index initialization fails, export a minimal app that returns 503
  // instead of crashing. Vercel can still respond rather than hanging.
  logError("server-init", error);
  app = express();
  app.use((_req, res) => {
    res.status(503).json({
      status: "error",
      message: "Service temporarily unavailable. Database initialization failed.",
    });
  });
}

export default app;
