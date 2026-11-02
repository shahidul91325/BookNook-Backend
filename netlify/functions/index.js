/**
 * Netlify Functions entry point for the BookNook Express API.
 *
 * Netlify Functions use the AWS Lambda signature `handler(event, context)`,
 * which is incompatible with Express's `(req, res)` handler. This thin adapter
 * reuses the SAME Express app factory (`src/app.ts` → `dist/app.js`) used by
 * the Vercel entry (`dist/api/index.js`) and the Render entry (`dist/server.js`),
 * wrapping it with `serverless-http` so Netlify can invoke it.
 *
 * No new server logic is introduced here — `createApp(db)` is the single
 * shared app factory across all three platforms (Vercel / Render / Netlify).
 */

import serverless from "serverless-http";
import { connectDB } from "../../dist/config/db.js";
import { ensureIndexes } from "../../dist/config/indexes.js";
import createApp from "../../dist/app.js";

/** Lazily-created, cached serverless handler bound to a (reused) MongoDB client. */
let handlerPromise = null;

const initHandler = async () => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const db = await connectDB();
      await ensureIndexes(db);
      const app = createApp(db);
      return serverless(app);
    })();
  }
  return handlerPromise;
};

/**
 * Netlify Function handler. Converts the Lambda `event`/`context` into an
 * Express request/response via `serverless-http` and returns the response.
 * The MongoDB client is cached by `src/config/db.ts` across warm invocations.
 */
export const handler = async (event, context) => {
  const handlerFn = await initHandler();
  return handlerFn(event, context);
};
