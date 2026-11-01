import type { NextFunction, Request, RequestHandler, Response } from "express";
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
  type BookSort,
  type CreateBookInput,
} from "../models/book.model.js";
import { isValidObjectId, toObjectId } from "../utils/objectId.js";
import { sendForbidden, sendUnauthorized } from "../middleware/auth.js";
import {
  createBookSchema,
  formatZodIssues,
  updateBookSchema,
} from "../validations/book.validation.js";

/**
 * Public book read controllers (GET /api/books, GET /api/books/:id).
 *
 * These endpoints are intentionally PUBLIC — the assignment requires the
 * catalog and book details to be readable without authentication. They
 * only ever READ from MongoDB; no mock or hardcoded data is involved.
 */

/**
 * Safety cap for a single page, protecting the database from unbounded
 * scans. When the frontend sends no `limit` (the catalog paginates
 * client-side), we return the full catalog up to this cap.
 */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = MAX_LIMIT;

/** Sort modes accepted from the frontend; anything else falls back to newest. */
const SORT_MODES: readonly BookSort[] = [
  "newest",
  "oldest",
  "title-asc",
  "title-desc",
  "quantity-desc",
];

/** Parses a positive integer query param, returning `fallback` when invalid. */
const parsePositiveInt = (
  raw: string | undefined,
  fallback: number
): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
};

/** Validates and normalizes the `sort` query param (defaults to newest). */
const parseSort = (raw: string | undefined): BookSort => {
  if (raw && (SORT_MODES as readonly string[]).includes(raw)) {
    return raw as BookSort;
  }
  return "newest";
};

/** GET /api/books — list books with category filter, search, sort, pagination. */
export const createGetBooks =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as Record<string, unknown>;

      const rawCategory = typeof query.category === "string" ? query.category.trim() : "";
      const rawSearch = typeof query.search === "string" ? query.search.trim() : "";

      const filter: BookListFilter = {};
      if (rawCategory && rawCategory !== "All") {
        filter.category = rawCategory;
      }
      if (rawSearch) {
        filter.search = rawSearch;
      }

      const limit = Math.min(
        parsePositiveInt(
          typeof query.limit === "string" ? query.limit : undefined,
          DEFAULT_LIMIT
        ),
        MAX_LIMIT
      );
      const page = parsePositiveInt(
        typeof query.page === "string" ? query.page : undefined,
        1
      );
      const sort = parseSort(typeof query.sort === "string" ? query.sort : undefined);

      const options: BookListOptions = {
        skip: (page - 1) * limit,
        limit,
        sort,
      };

      const { books, total } = await listBooks(getBooksCollection(db), filter, options);

      res.status(200).json({
        status: "success",
        results: books.length,
        total,
        page,
        limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        // The frontend reads the array from the `books` key of the envelope.
        books: books.map(toBookResponse),
      });
    } catch (error) {
      next(error);
    }
  };

/** GET /api/books/:id — fetch one book by its MongoDB ObjectId. */
export const createGetBookById =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawId = req.params.id;
      const id = typeof rawId === "string" ? rawId : "";

      // Malformed ids are a client error, not a server crash — reject early.
      if (!id || !isValidObjectId(id)) {
        res.status(400).json({
          status: "fail",
          message: "Invalid book id. Expected a 24-character MongoDB ObjectId.",
        });
        return;
      }

      const book = await findBookById(getBooksCollection(db), id);
      if (!book) {
        res.status(404).json({
          status: "fail",
          message: "Book not found.",
        });
        return;
      }

      // The frontend reads the book from the `data` key of the envelope.
      res.status(200).json({
        status: "success",
        data: toBookResponse(book),
      });
    } catch (error) {
      next(error);
    }
  };

/**
 * POST /api/books — create a book (requires verified authentication).
 *
 * Ownership (`addedBy` / `addedByName` / `addedByEmail`) is taken
 * EXCLUSIVELY from `req.auth`, which the Phase 3 middleware populated by
 * cryptographically verifying the Better Auth session. Anything ownership-
 * related in the request body (`userName`, `userEmail`, `addedBy`, …) is
 * stripped by the Zod schema and can never influence the stored document.
 */
export const createCreateBook =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // `requireAuth` runs first; this is a defensive guard so identity is
      // never inferred from the request if the middleware chain changed.
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const parsed = createBookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          status: "fail",
          message: "Validation failed. Please fix the highlighted fields.",
          errors: formatZodIssues(parsed.error),
        });
        return;
      }

      const payload = parsed.data;

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
      res.status(201).json({
        status: "success",
        message: "Book added to the library.",
        data: toBookResponse(book),
      });
    } catch (error) {
      next(error);
    }
  };

/** Extracts the raw `:id` route param as a string (Express 5 types). */
const getRouteId = (req: Request): string => {
  const rawId = req.params.id;
  return typeof rawId === "string" ? rawId : "";
};

/**
 * Shared core for PATCH/PUT /api/books/:id — update a book the caller owns.
 *
 * Ownership is decided by comparing the book's stored `addedBy` (the
 * verified user id written at creation time) with `req.auth.user.id` from
 * the cryptographically verified session. Client-supplied identity fields
 * in the body are stripped by the Zod schema and can never reassign the
 * book. Only fields present in the body are written; everything else is
 * preserved untouched, and `updatedAt` is refreshed server-side.
 */
const handleUpdateBook =
  (db: Db): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const id = getRouteId(req);
      if (!id || !isValidObjectId(id)) {
        res.status(400).json({
          status: "fail",
          message: "Invalid book id. Expected a 24-character MongoDB ObjectId.",
        });
        return;
      }

      const book = await findBookById(getBooksCollection(db), id);
      if (!book) {
        res.status(404).json({ status: "fail", message: "Book not found." });
        return;
      }

      // Only the original owner (matched by verified user id) may update.
      if (book.addedBy !== auth.user.id) {
        sendForbidden(res, "You can only edit books you have added.");
        return;
      }

      const parsed = updateBookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          status: "fail",
          message: "Validation failed. Please fix the highlighted fields.",
          errors: formatZodIssues(parsed.error),
        });
        return;
      }

      const payload = parsed.data;

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
        res.status(404).json({ status: "fail", message: "Book not found." });
        return;
      }

      res.status(200).json({
        status: "success",
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const id = getRouteId(req);
      if (!id || !isValidObjectId(id)) {
        res.status(400).json({
          status: "fail",
          message: "Invalid book id. Expected a 24-character MongoDB ObjectId.",
        });
        return;
      }

      const book = await findBookById(getBooksCollection(db), id);
      if (!book) {
        res.status(404).json({ status: "fail", message: "Book not found." });
        return;
      }

      // Only the original owner (matched by verified user id) may delete.
      if (book.addedBy !== auth.user.id) {
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
        res.status(409).json({
          status: "fail",
          message:
            `This book cannot be deleted: ${activeBorrows} active borrow ` +
            "record(s) still reference it. Collect the book(s) and mark " +
            "the borrows as returned first.",
        });
        return;
      }

      // Query-level ownership guard; only deletes if still the owner.
      const deleted = await deleteBookForOwner(
        getBooksCollection(db),
        id,
        auth.user.id
      );
      if (!deleted) {
        res.status(404).json({ status: "fail", message: "Book not found." });
        return;
      }

      // Remove the book's (already-returned) borrow history so no orphaned
      // records referencing the deleted bookId remain.
      const removedBorrows = await deleteBorrowsByBook(
        getBorrowsCollection(db),
        book._id as ObjectId
      );

      res.status(200).json({
        status: "success",
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!auth) {
        sendUnauthorized(res);
        return;
      }

      const { books, total } = await listBooks(
        getBooksCollection(db),
        { addedBy: auth.user.id },
        { sort: "newest" }
      );

      res.status(200).json({
        status: "success",
        results: books.length,
        total,
        books: books.map(toBookResponse),
      });
    } catch (error) {
      next(error);
    }
  };
