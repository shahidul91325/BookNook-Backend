import type { RequestHandler } from "express";
import type { Db, ObjectId } from "mongodb";
import { getBooksCollection, getBorrowsCollection } from "../config/collections.js";
import {
  deleteBookForOwner,
  findBookById,
  insertBook,
  listBooks,
  updateBookForOwner,
  type BookListOptions,
} from "../repositories/book.repository.js";
import {
  countActiveBorrowsByBook,
  deleteBorrowsByBook,
} from "../repositories/borrow.repository.js";
import {
  toBookResponse,
  type BookListFilter,
  type CreateBookInput,
} from "../models/book.model.js";
import { getRouteId } from "../utils/objectId.js";
import {
  isOwner,
  requireAuthContext,
  sendForbidden,
} from "../middleware/auth.js";
import { sendError, sendNotFound, sendSuccess } from "../utils/httpResponse.js";
import {
  listBooksQuerySchema,
  type CreateBookPayload,
  type UpdateBookPayload,
} from "../validations/book.validation.js";

/**
 * Book controllers (public reads + authenticated writes).
 *
 * SECURITY CONTRACT (do not weaken):
 *   - Identity always comes from `req.auth`, which the Phase 3 middleware
 *     populated from a cryptographically verified Better Auth session.
 *   - Request bodies are parsed by the `validateBody` route middleware,
 *     whose Zod schemas STRIP ownership/identity fields — so `addedBy`,
 *     `userName`, `userEmail`, timestamps, … sent by a client can never
 *     influence what is stored. Controllers read only `CreateBookPayload`
 *     / `UpdateBookPayload` fields.
 *   - Ownership is decided by comparing the book's STORED `addedBy` with
 *     the verified session user id, and the final write re-asserts
 *     ownership inside the MongoDB query itself (defense in depth).
 *   - Malformed ObjectIds never reach the database: the `validateObjectId`
 *     route middleware answers 400 first.
 */

/**
 * Public book read controllers (GET /api/books, GET /api/books/:id).
 *
 * These endpoints are intentionally PUBLIC — the assignment requires the
 * catalog and book details to be readable without authentication. They
 * only ever READ from MongoDB; no mock or hardcoded data is involved.
 */

/** GET /api/books — list books with category filter, search, sort, pagination. */
export const createGetBooks =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      // Lenient, total parse: malformed params fall back to safe defaults
      // (the established contract — see listBooksQuerySchema).
      const query = listBooksQuerySchema.parse(req.query);

      const filter: BookListFilter = {};
      if (query.category && query.category !== "All") {
        filter.category = query.category;
      }
      if (query.search) {
        filter.search = query.search;
      }

      const options: BookListOptions = {
        skip: (query.page - 1) * query.limit,
        limit: query.limit,
        sort: query.sort,
      };

      const { books, total } = await listBooks(getBooksCollection(db), filter, options);

      // The frontend reads the array from the `books` key of the envelope.
      sendSuccess(res, {
        results: books.length,
        total,
        page: query.page,
        limit: query.limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
        books: books.map(toBookResponse),
      });
    } catch (error) {
      next(error);
    }
  };

/** GET /api/books/:id — fetch one book by its MongoDB ObjectId. */
export const createGetBookById =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const book = await findBookById(getBooksCollection(db), getRouteId(req));
      if (!book) {
        sendNotFound(res, "Book not found.");
        return;
      }

      // The frontend reads the book from the `data` key of the envelope.
      sendSuccess(res, { data: toBookResponse(book) });
    } catch (error) {
      next(error);
    }
  };

/**
 * POST /api/books — create a book (requires verified authentication).
 *
 * Ownership (`addedBy` / `addedByName` / `addedByEmail`) is taken
 * EXCLUSIVELY from `req.auth`; anything ownership-related in the request
 * body was already stripped by the Zod schema in `validateBody`.
 */
export const createCreateBook =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      // `requireAuth` runs first; this is a defensive guard so identity is
      // never inferred from the request if the middleware chain changed.
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const payload = req.body as CreateBookPayload;

      // Server-derived book document: ownership comes from the verified
      // session, timestamps are generated here, and both copy counters
      // start at the validated quantity (everything available on creation).
      const input: CreateBookInput = {
        title: payload.title,
        author: payload.author,
        category: payload.category,
        image: payload.image,
        description: payload.description,
        addedBy: auth.user.id,
        addedByName: auth.user.name,
        addedByEmail: auth.user.email,
        totalCopies: payload.quantity,
        availableCopies: payload.quantity,
        ...(payload.rating !== undefined ? { rating: payload.rating } : {}),
      };

      const book = await insertBook(getBooksCollection(db), input);

      // 201 Created + the same `data` envelope the details endpoint returns.
      sendSuccess(
        res,
        { message: "Book added to the library.", data: toBookResponse(book) },
        201
      );
    } catch (error) {
      next(error);
    }
  };

/**
 * Update a book through PATCH /api/books/:id when the caller owns it.
 *
 * Ownership is decided by comparing the book's stored `addedBy` (the
 * verified user id written at creation time) with `req.auth.user.id` from
 * the cryptographically verified session. Client-supplied identity fields
 * in the body were stripped by the Zod schema and can never reassign the
 * book. Only fields present in the body are written; everything else is
 * preserved untouched, and `updatedAt` is refreshed server-side.
 */
const handleUpdateBook =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const id = getRouteId(req);

      const book = await findBookById(getBooksCollection(db), id);
      if (!book) {
        sendNotFound(res, "Book not found.");
        return;
      }

      // Only the original owner (matched by verified user id) may update.
      if (!isOwner(req, book.addedBy)) {
        sendForbidden(res, "You can only edit books you have added.");
        return;
      }

      const payload = req.body as UpdateBookPayload;

      // Build the $set document from PROVIDED fields only — omitted fields
      // stay as they are. Ownership fields are impossible here: the Zod
      // schema has no such keys, so they were stripped during parsing.
      const update: Partial<CreateBookInput> = {};
      if (payload.title !== undefined) update.title = payload.title;
      if (payload.author !== undefined) update.author = payload.author;
      if (payload.category !== undefined) update.category = payload.category;
      if (payload.image !== undefined) update.image = payload.image;
      if (payload.description !== undefined) update.description = payload.description;
      if (payload.rating !== undefined) update.rating = payload.rating;
      if (payload.quantity !== undefined) {
        update.totalCopies = payload.quantity;
        // Keep availableCopies consistent: copies already out on loan can
        // never be marked available again (floored at 0).
        const activeBorrows = await countActiveBorrowsByBook(
          getBorrowsCollection(db),
          book._id as ObjectId
        );
        update.availableCopies = Math.max(payload.quantity - activeBorrows, 0);
      }

      // Query-level ownership guard as defense-in-depth on top of the
      // check above (protects against a concurrent ownership edge case).
      const updated = await updateBookForOwner(
        getBooksCollection(db),
        id,
        auth.user.id,
        update
      );
      if (!updated) {
        sendNotFound(res, "Book not found.");
        return;
      }

      sendSuccess(res, {
        message: "Book updated successfully.",
        data: toBookResponse(updated),
      });
    } catch (error) {
      next(error);
    }
  };

/** PATCH /api/books/:id — partial update (assignment-specified verb). */
export const createUpdateBook = (db: Db): RequestHandler => handleUpdateBook(db);

/**
 * DELETE /api/books/:id — remove a book the caller owns.
 *
 * Books with active (unreturned) borrows are protected with 409 Conflict
 * so borrowers are never left holding a record of a book that no longer
 * exists. Once deletion is allowed, the book's borrow records (history)
 * are removed in the same request so no orphaned records referencing the
 * deleted bookId remain in the `borrows` collection.
 */
export const createDeleteBook =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const id = getRouteId(req);

      const book = await findBookById(getBooksCollection(db), id);
      if (!book) {
        sendNotFound(res, "Book not found.");
        return;
      }

      // Only the original owner (matched by verified user id) may delete.
      if (!isOwner(req, book.addedBy)) {
        sendForbidden(res, "You can only delete books you have added.");
        return;
      }

      // Refuse while any copy is still out on loan — deleting now would
      // leave borrowers with records pointing to a nonexistent book.
      const activeBorrows = await countActiveBorrowsByBook(
        getBorrowsCollection(db),
        book._id as ObjectId
      );
      if (activeBorrows > 0) {
        sendError(
          res,
          409,
          `This book cannot be deleted: ${activeBorrows} active borrow ` +
            "record(s) still reference it. Collect the book(s) and mark " +
            "the borrows as returned first."
        );
        return;
      }

      // Query-level ownership guard; only deletes if still the owner.
      const deleted = await deleteBookForOwner(
        getBooksCollection(db),
        id,
        auth.user.id
      );
      if (!deleted) {
        sendNotFound(res, "Book not found.");
        return;
      }

      // Remove the book's (already-returned) borrow history so no orphaned
      // records referencing the deleted bookId remain.
      const removedBorrows = await deleteBorrowsByBook(
        getBorrowsCollection(db),
        book._id as ObjectId
      );

      sendSuccess(res, {
        // The frontend's deleteBook() reads `success` / `message` directly.
        success: true,
        message: "Book deleted successfully.",
        removedBorrowRecords: removedBorrows,
      });
    } catch (error) {
      next(error);
    }
  };

/**
 * GET /api/my-books — list only the caller's own books.
 *
 * The owner filter is ALWAYS the verified session user id
 * (`req.auth.user.id`). The email the frontend happens to pass in its
 * fallback chain is never read from the query string, so a client cannot
 * ask for (or spoof) another user's list.
 */
export const createGetMyBooks =
  (db: Db): RequestHandler =>
  async (req, res, next): Promise<void> => {
    try {
      const auth = requireAuthContext(req, res);
      if (!auth) return;

      const { books, total } = await listBooks(
        getBooksCollection(db),
        { addedBy: auth.user.id },
        { sort: "newest" }
      );

      sendSuccess(res, {
        results: books.length,
        total,
        books: books.map(toBookResponse),
      });
    } catch (error) {
      next(error);
    }
  };
