import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db, ObjectId } from "mongodb";
import { MongoServerError } from "mongodb";
import { getBooksCollection, getBorrowsCollection } from "../config/collections.js";
import {
  findBookById,
  releaseOneCopy,
  reserveOneCopy,
} from "../repositories/book.repository.js";
import {
  findBorrowById,
  insertBorrow,
  listBorrowsByUser,
  markBorrowReturned,
} from "../repositories/borrow.repository.js";
import {
  toBorrowResponse,
  type CreateBorrowInput,
} from "../models/borrow.model.js";
import { isValidObjectId, toObjectId } from "../utils/objectId.js";
import { sendUnauthorized } from "../middleware/auth.js";
import { borrowBookSchema } from "../validations/borrow.validation.js";
import {
  OperationError,
  runWithTransactionOrFallback,
} from "../utils/transaction.js";

/**
 * Borrow & return controllers (POST /api/borrows, GET /api/borrows,
 * DELETE /api/borrows/:id).
 *
 * Inventory safety strategy (works on BOTH replica sets and standalone
 * mongods):
 *   - Borrow: a CONDITIONAL decrement (`availableCopies > 0`) atomically
 *     reserves the copy — two concurrent requests can never take the same
 *     final copy. A partial unique index on {userId, bookId} where
 *     status="borrowed" (created in src/config/indexes.ts) rejects
 *     duplicate active borrows at the DB level. On replica sets the whole
 *     reserve+insert runs in a transaction (auto-abort rolls the decrement
 *     back on any failure); on standalone the fallback path compensates
 *     manually by releasing the copy if the insert fails.
 *   - Return: an ATOMIC conditional flip (borrowed → returned) is the
 *     gate — exactly one request can win it, so availableCopies is
 *     restored exactly once, clamped at totalCopies.
 */

/** Maps domain/Mongo errors to consistent client responses. */
const respondError = (res: Response, error: unknown): boolean => {
  if (error instanceof OperationError) {
    res.status(error.statusCode).json({ status: "fail", message: error.message });
    return true;
  }
  // Partial unique index violation: {userId, bookId} already borrowed.
  if ((error as MongoServerError)?.code === 11000) {
    res.status(409).json({
      status: "fail",
      message: "You already have this book borrowed. Return it before borrowing again.",
    });
    return true;
  }
  return false;
};

/**
 * POST /api/borrows — borrow a book (requires verified authentication).
 *
 * Identity comes exclusively from the verified session; the book's
 * title/image are read from the MongoDB document the server fetched —
 * never from the request body (Zod strips those keys).
 */
export const createBorrowBook =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const parsed = borrowBookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          status: "fail",
          message: "Validation failed. Please fix the highlighted fields.",
          errors: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join(".") || "_", [i.message]])
          ),
        });
        return;
      }

      const { bookId, returnDate } = parsed.data;

      const book = await findBookById(getBooksCollection(db), bookId);
      if (!book) {
        res.status(404).json({ status: "fail", message: "Book not found." });
        return;
      }

      // Fast-path duplicate check (friendly message); the unique partial
      // index still guards the concurrent race.
      const alreadyBorrowed = await getBorrowsCollection(db).findOne({
        userId: auth.user.id,
        bookId: book._id as ObjectId,
        status: "borrowed",
      });
      if (alreadyBorrowed) {
        res.status(409).json({
          status: "fail",
          message: "You already have this book borrowed. Return it before borrowing again.",
        });
        return;
      }

      // Server-built record: verified identity + DB book info + validated
      // deadline (the requested one, or the default lending period).
      const input: CreateBorrowInput = {
        bookId: book._id as ObjectId,
        bookTitle: book.title,
        bookImage: book.image,
        userId: auth.user.id,
        userName: auth.user.name,
        userEmail: auth.user.email,
        ...(returnDate ? { returnDate } : {}),
      };

      let borrow;
      try {
        borrow = await runWithTransactionOrFallback(
          db,
          // Replica set: reserve + insert inside one transaction — any
          // failure auto-rolls-back the reserved copy.
          async (session) => {
            const reserved = await reserveOneCopy(
              getBooksCollection(db),
              bookId,
              session
            );
            if (!reserved) {
              throw new OperationError(
                409,
                "No copies of this book are currently available."
              );
            }
            return insertBorrow(getBorrowsCollection(db), input, session);
          },
          // Standalone: atomic conditional reserve + manual compensation.
          async () => {
            const reserved = await reserveOneCopy(getBooksCollection(db), bookId);
            if (!reserved) {
              throw new OperationError(
                409,
                "No copies of this book are currently available."
              );
            }
            try {
              return await insertBorrow(getBorrowsCollection(db), input);
            } catch (insertError) {
              // Undo the reservation so inventory stays consistent.
              await releaseOneCopy(getBooksCollection(db), bookId);
              throw insertError;
            }
          }
        );
      } catch (error) {
        if (respondError(res, error)) return;
        throw error;
      }

      res.status(201).json({
        status: "success",
        message: "Book borrowed successfully.",
        data: toBorrowResponse(borrow),
      });
    } catch (error) {
      next(error);
    }
  };

/**
 * GET /api/borrows — the authenticated user's borrow records only.
 *
 * The filter is ALWAYS the verified session user id; any client-supplied
 * email/userId query parameter is ignored, so one user can never list
 * another's records.
 */
export const createGetMyBorrows =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const { borrows, total } = await listBorrowsByUser(
        getBorrowsCollection(db),
        { userId: auth.user.id },
        { limit: 500 }
      );

      // `data` key: the frontend's unwrapData() reads the array from there.
      res.status(200).json({
        status: "success",
        results: borrows.length,
        total,
        data: borrows.map(toBorrowResponse),
      });
    } catch (error) {
      next(error);
    }
  };

/**
 * DELETE /api/borrows/:id — mark a borrow record as returned.
 *
 * The record must belong to the authenticated user. The borrowed→returned
 * flip is an atomic conditional update, so duplicate/concurrent returns
 * can restore the copy exactly once. PUT/PATCH /api/borrows/:id/return are
 * aliases matching the frontend's preferred return paths.
 */
export const createReturnBook =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const rawId = req.params.id;
      const id = typeof rawId === "string" ? rawId : "";
      if (!id || !isValidObjectId(id)) {
        res.status(400).json({
          status: "fail",
          message: "Invalid borrow id. Expected a 24-character MongoDB ObjectId.",
        });
        return;
      }

      const record = await findBorrowById(getBorrowsCollection(db), id);
      if (!record) {
        res.status(404).json({ status: "fail", message: "Borrow record not found." });
        return;
      }

      // Only the borrower may return their own record.
      if (record.userId !== auth.user.id) {
        res.status(403).json({
          status: "fail",
          message: "You can only return books you have borrowed.",
        });
        return;
      }

      // Duplicate return guard (the atomic flip below also enforces this).
      if (record.status === "returned") {
        res.status(409).json({
          status: "fail",
          message: "This book has already been returned.",
        });
        return;
      }

      const bookId = (record.bookId as ObjectId).toString();

      try {
        await runWithTransactionOrFallback(
          db,
          // Replica set: flip + inventory restore in one transaction.
          async (session) => {
            const flipped = await markBorrowReturned(
              getBorrowsCollection(db),
              id,
              session
            );
            if (!flipped) {
              throw new OperationError(
                409,
                "This book has already been returned."
              );
            }
            await releaseOneCopy(getBooksCollection(db), bookId, session);
          },
          // Standalone: atomic flip as the exactly-once gate, then restore.
          async () => {
            const flipped = await markBorrowReturned(getBorrowsCollection(db), id);
            if (!flipped) {
              throw new OperationError(
                409,
                "This book has already been returned."
              );
            }
            await releaseOneCopy(getBooksCollection(db), bookId);
          }
        );
      } catch (error) {
        if (respondError(res, error)) return;
        throw error;
      }

      res.status(200).json({
        status: "success",
        // The frontend's returnBook() reads `success` / `message` directly.
        success: true,
        message: "Book returned successfully.",
      });
    } catch (error) {
      next(error);
    }
  };
