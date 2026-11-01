import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors, { type CorsOptions } from "cors";
import type { Db } from "mongodb";
import { env } from "./config/env.js";
import { createRequireAuth } from "./middleware/auth.js";
import {
  createCreateBook,
  createDeleteBook,
  createGetBooks,
  createGetBookById,
  createGetMyBooks,
  createUpdateBook,
} from "./controllers/book.controller.js";
import {
  createBorrowBook,
  createGetMyBorrows,
  createReturnBook,
} from "./controllers/borrow.controller.js";

const createApp = (db: Db): Express => {
  const app = express();

  // CORS — allow only the Next.js frontend origin
  const corsOptions: CorsOptions = {
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  };
  app.use(cors(corsOptions));
  app.use(express.json());

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "success",
      message: "BookNook API is running",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Protected routes ────────────────────────────────────────────────────
  // Every private route goes through `requireAuth`, which only trusts a
  // cryptographically verified Better Auth session — never client-supplied
  // identity fields. `req.auth.user.id` is the stable verified user id.
  const requireAuth = createRequireAuth(db);

  // Returns the identity the SERVER verified for the caller. The client
  // cannot influence any field of this response.
  app.get("/api/auth/me", requireAuth, (req: Request, res: Response) => {
    res.status(200).json({
      status: "success",
      data: req.auth?.user,
    });
  });

  // Create a book. `requireAuth` establishes identity from the verified
  // Better Auth session; ownership fields in the body are ignored.
  app.post("/api/books", requireAuth, createCreateBook(db));

  // ── My Books (owner list) ──────────────────────────────────────────────
  // The frontend's getMyBooks() tries /api/my-books first, then falls back
  // to /api/books/my and /api/books/user. All three are implemented so the
  // fallback chain resolves on the first hop. The owner filter is ALWAYS
  // the verified session user id — the email in the frontend's final
  // fallback (/api/books/user/:email) is deliberately NOT implemented as an
  // identity source: trusting a client-supplied email would let anyone
  // enumerate another user's books. That route simply 404s, and the chain
  // never reaches it because the session-based routes succeed.
  // Registered BEFORE GET /api/books/:id so ":id" cannot swallow "my"/"user".
  app.get("/api/my-books", requireAuth, createGetMyBooks(db));
  app.get("/api/books/my", requireAuth, createGetMyBooks(db));
  app.get("/api/books/user", requireAuth, createGetMyBooks(db));

  // ── Public book read APIs ───────────────────────────────────────────────
  // Assignment requirement: catalog + details stay publicly readable.
  // NOTE: static sub-routes (e.g. GET /api/books/my) are registered above,
  // BEFORE this `:id` route, otherwise ":id" would swallow them.
  app.get("/api/books", createGetBooks(db));
  app.get("/api/books/:id", createGetBookById(db));

  // ── Book update & delete (owner-only) ──────────────────────────────────
  // The assignment specifies PATCH /api/books/:id; the frontend's
  // bookService.updateBook() sends PUT. Both verbs share the same handler
  // so the API contract holds for either caller. DELETE matches the
  // frontend's bookService.deleteBook() exactly.
  app.patch("/api/books/:id", requireAuth, createUpdateBook(db));
  app.put("/api/books/:id", requireAuth, createUpdateBook(db));
  app.delete("/api/books/:id", requireAuth, createDeleteBook(db));

  // ── Borrowing & returning ──────────────────────────────────────────────
  // POST /api/borrows reserves a copy atomically and records the borrow.
  app.post("/api/borrows", requireAuth, createBorrowBook(db));

  // GET /api/borrows lists ONLY the verified session user's records. The
  // aliases match the frontend's getUserBorrows() fallback chain; the
  // email-based variants (/api/borrows/user/:email, ?email=) are
  // deliberately NOT implemented — identity never comes from the client.
  app.get("/api/borrows", requireAuth, createGetMyBorrows(db));
  app.get("/api/my-borrows", requireAuth, createGetMyBorrows(db));
  app.get("/api/borrows/my", requireAuth, createGetMyBorrows(db));
  app.get("/api/borrows/user", requireAuth, createGetMyBorrows(db));

  // DELETE /api/borrows/:id marks the borrow returned and restores the
  // copy exactly once. The PUT/PATCH /return aliases match the frontend's
  // preferred returnBook() paths so its first request succeeds.
  app.delete("/api/borrows/:id", requireAuth, createReturnBook(db));
  app.put("/api/borrows/:id/return", requireAuth, createReturnBook(db));
  app.patch("/api/borrows/:id/return", requireAuth, createReturnBook(db));

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      status: "fail",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    });
  });

  // Centralized error handler (must come after routes)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({
      status: "error",
      message: "Something went wrong on the server",
    });
  });

  return app;
};

export default createApp;
