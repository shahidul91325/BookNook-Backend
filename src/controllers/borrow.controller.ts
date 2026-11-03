import type { RequestHandler } from "express";
import type { Db, ObjectId } from "mongodb";
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
import { getRouteId } from "../utils/objectId.js";
import { isOwner, requireAuthContext, sendForbidden } from "../middleware/auth.js";
import { sendError, sendNotFound, sendSuccess } from "../utils/httpResponse.js";
import type { BorrowBookPayload } from "../validations/borrow.validation.js";
import { OperationError } from "../utils/errors.js";
import { runWithTransactionOrFallback } from "../utils/transaction.js";

/**
 * Borrow & return controllers (POST /api/borrows, GET /api/borrows,
 * DELETE /api/borrows/:id).
 *
 * SECURITY CONTRACT (do not weaken):
 *   - Identity always comes from the verified session (`req.auth`); the
 *     request body's `bookTitle` / `bookImage` / `userName` / `userEmail`
 *     were stripped by the Zod schema in `validateBody`. The book's
 *     title/image are read from the MongoDB document the server fetched.
 *   - A borrow record can only be returned by the user it belongs to
 *     (`isOwner` against the record's stored `userId`).
 *   - Domain failures (`OperationError`) and MongoDB duplicate-key errors
 *     propagate to the centralized error handler, which maps them to the
 *     standard 409/500 envelopes — no driver internals ever leave here.
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

/**
 * POST /api/borrows — borrow a book (requires verified authentication).
 */
export const createBorrowBook =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const { bookId, returnDate } = req.body as BorrowBookPayload;

      const book = await findBookById(getBooksCollection(db), bookId);
      if (!book) {
        sendNotFound(res, "Book not found.");
        return;
      }

      // Fast-path duplicate check (friendly message); the unique partial
      // index still guards the concurrent race (its E11000 becomes a 409
      // in the centralized error handler).
      const alreadyBorrowed = await getBorrowsCollection(db).findOne({
        userId: auth.user.id,
        bookId: book._id as ObjectId,
        status: "borrowed",
      });
      if (alreadyBorrowed) {
        sendError(
          res,
          409,
          "You already have this book borrowed. Return it before borrowing again."
        );
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

      // `OperationError`s (e.g. no copies left) and duplicate-key races
      // bubble up to the centralized error handler.
      const borrow = await runWithTransactionOrFallback(
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

      sendSuccess(
        res,
        { message: "Book borrowed successfully.", data: toBorrowResponse(borrow) },
        201
      );
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
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const { borrows, total } = await listBorrowsByUser(
        getBorrowsCollection(db),
        { userId: auth.user.id },
        { limit: 500 }
      );

      // `data` key: the frontend's unwrapData() reads the array from there.
      sendSuccess(res, {
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
 * can restore the copy exactly once.
 */
export const createReturnBook =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const id = getRouteId(req);

      const record = await findBorrowById(getBorrowsCollection(db), id);
      if (!record) {
        sendNotFound(res, "Borrow record not found.");
        return;
      }

      // Only the borrower may return their own record.
      if (!isOwner(req, record.userId)) {
        sendForbidden(res, "You can only return books you have borrowed.");
        return;
      }

      // Duplicate return guard (the atomic flip below also enforces this).
      if (record.status === "returned") {
        sendError(res, 409, "This book has already been returned.");
        return;
      }

      const bookId = (record.bookId as ObjectId).toString();

      // `OperationError`s (e.g. already returned by a concurrent request)
      // bubble up to the centralized error handler → 409.
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

      sendSuccess(res, {
        // The frontend's returnBook() reads `success` / `message` directly.
        success: true,
        message: "Book returned successfully.",
      });
    } catch (error) {
      next(error);
    }
  };
