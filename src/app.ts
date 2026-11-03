import express, { type Express, type Request, type Response } from 'express';
import cors, { type CorsOptions } from 'cors';
import type { Db } from 'mongodb';
import { toNodeHandler } from 'better-auth/node';
import { createAuth } from './auth.js';
import { env } from './config/env.js';
import { createRequireAuth } from './middleware/auth.js';
import { validateBody, validateObjectId } from './middleware/validate.js';
import { createRateLimit, type RateLimitOptions } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { sendSuccess } from './utils/httpResponse.js';
import {
  createCreateBook,
  createDeleteBook,
  createGetBooks,
  createGetBookById,
  createGetMyBooks,
  createUpdateBook,
} from './controllers/book.controller.js';
import { createBorrowBook, createGetMyBorrows, createReturnBook } from './controllers/borrow.controller.js';
import { createBookSchema, updateBookSchema } from './validations/book.validation.js';
import { borrowBookSchema } from './validations/borrow.validation.js';

/**
 * Hardening options for `createApp` — mainly used by verification scripts
 * to exercise the rate limiter with tiny budgets without touching the
 * process-wide configuration. Production code calls `createApp(db)`.
 */
export type AppOptions = {
  rateLimit?: {
    global?: Partial<Omit<RateLimitOptions, 'scope'>>;
    write?: Partial<Omit<RateLimitOptions, 'scope'>>;
  };
};

/**
 * Max JSON request body. Book payloads top out around a few KB (the Zod
 * schemas cap every string field), so half a megabyte is already very
 * generous — anything larger is rejected with 413 before parsing.
 */
const JSON_BODY_LIMIT = '512kb';

/**
 * Minimal API security headers (no extra dependency needed).
 *   - `nosniff`: responses must be consumed as their declared type.
 *   - `X-Frame-Options: DENY`: API payloads must not be framed.
 *   - `Referrer-Policy`: no referrer leaks from API consumers.
 *   - `Cache-Control: no-store`: responses include private user data
 *     (borrows, emails); they must never be cached by proxies/browsers.
 */
const applySecurityHeaders = (req: Request, res: Response, next: () => void) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
};

const createApp = (db: Db, options: AppOptions = {}): Express => {
  const app = express();

  // Behind a trusted reverse proxy? Only then trust X-Forwarded-For so
  // rate limiting sees real client IPs (see TRUST_PROXY in .env.example —
  // enabling it on a directly-exposed server would let clients spoof IPs).
  if (env.TRUST_PROXY > 0) {
    app.set('trust proxy', env.TRUST_PROXY);
  }
  // Do not advertise the framework in the X-Powered-By header.
  app.disable('x-powered-by');

  // ── CORS ────────────────────────────────────────────────────────────────
  // Allowlist only: `env.CORS_ORIGINS` holds exact origins parsed at startup.
  // Auth cookies are proxied through Next.js; REST authorization uses JWTs.
  const corsOptions: CorsOptions = {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
  app.use(cors(corsOptions));
  app.use(applySecurityHeaders);

  // Better Auth owns all /api/auth endpoints. Mount before express.json so
  // its handler can read the original request stream and set session cookies.
  const auth = createAuth(db);
  app.all(/^\/api\/auth(?:\/.*)?$/, toNodeHandler(auth));

  // Body parsing with a hard size cap; oversized/malformed bodies are
  // turned into clean 413/400 envelopes by the centralized error handler.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // ── Rate limiting ───────────────────────────────────────────────────────
  // Two in-memory buckets per client IP: a broad one for ALL traffic, and
  // a stricter one for write endpoints (create/update/delete/borrow/
  // return) — the sensitive operations an attacker would abuse. Both run
  // BEFORE authentication so hammering cannot drive session lookups.
  const globalLimiter = createRateLimit({
    scope: 'global',
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    ...options.rateLimit?.global,
  });
  const writeLimiter = createRateLimit({
    scope: 'write',
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_WRITE_MAX,
    ...options.rateLimit?.write,
  });
  app.use(globalLimiter);

  // Health check — root path (no auth, no DB required)
  app.get('/', (_req: Request, res: Response) => {
    sendSuccess(res, {
      message: 'BookNook API is running',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });
  // Note: `createApp` never calls `app.listen()`. Listening is the
  // responsibility of `src/server.ts` (persistent dev/production server).
  // The root Vercel entry point exports the returned Express app directly;
  // no listening socket is opened in a serverless function.
  // Health check — /api/health (no auth, no DB required)
  app.get('/api/health', (_req: Request, res: Response) => {
    sendSuccess(res, {
      message: 'BookNook API is running',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Public testimonials ────────────────────────────────────────────────
  // Public read endpoint expected by the frontend. Returns an empty list
  // when no testimonials are configured — no auth, no DB required.
  app.get('/api/testimonials', (_req: Request, res: Response) => {
    sendSuccess(res, {
      results: 0,
      testimonials: [],
    });
  });

  // ── Protected routes ────────────────────────────────────────────────────
  // Every private route goes through `requireAuth`, which only trusts a
  // cryptographically verified Better Auth JWT — never client-supplied
  // identity fields. `req.auth.user.id` is the stable verified user id.
  // Middleware order on writes: rate limit → auth → id check → body check,
  // preserving the response precedence 429 → 401 → 400 → 404 → 403.
  const requireAuth = createRequireAuth(db);

  // Create a book. `requireAuth` establishes identity from the verified JWT;
  // `validateBody` strips ownership fields from the
  // body so they can never reach the document.
  app.post('/api/books', writeLimiter, requireAuth, validateBody(createBookSchema), createCreateBook(db));

  // ── My Books (owner list) ──────────────────────────────────────────────
  // The owner filter always comes from the verified JWT subject.
  app.get('/api/my-books', requireAuth, createGetMyBooks(db));

  // ── Public book read APIs ───────────────────────────────────────────────
  // Assignment requirement: catalog + details stay publicly readable.
  app.get('/api/books', createGetBooks(db));
  app.get('/api/books/:id', validateObjectId('book'), createGetBookById(db));

  // ── Book update & delete (owner-only) ──────────────────────────────────
  // PATCH is the single partial-update contract used by the frontend.
  const updateGuards = [writeLimiter, requireAuth, validateObjectId('book'), validateBody(updateBookSchema)] as const;
  app.patch('/api/books/:id', ...updateGuards, createUpdateBook(db));
  app.delete('/api/books/:id', writeLimiter, requireAuth, validateObjectId('book'), createDeleteBook(db));

  // ── Borrowing & returning ──────────────────────────────────────────────
  // POST /api/borrows reserves a copy atomically and records the borrow.
  app.post('/api/borrows', writeLimiter, requireAuth, validateBody(borrowBookSchema), createBorrowBook(db));

  // GET /api/borrows lists only the verified JWT subject's records.
  app.get('/api/borrows', requireAuth, createGetMyBorrows(db));

  // DELETE /api/borrows/:id marks the record returned and restores the copy.
  app.delete('/api/borrows/:id', writeLimiter, requireAuth, validateObjectId('borrow'), createReturnBook(db));

  // 404 + centralized error handling (must come after routes).
  // The error handler maps every failure onto the standard envelope and
  // keeps stack traces / driver details out of responses.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export default createApp;
