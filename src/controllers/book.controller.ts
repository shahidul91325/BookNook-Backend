import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "mongodb";
import { getBooksCollection } from "../config/collections.js";
import {
  findBookById,
  listBooks,
  type BookListOptions,
} from "../repositories/book.repository.js";
import {
  toBookResponse,
  type BookListFilter,
  type BookSort,
} from "../models/book.model.js";
import { isValidObjectId } from "../utils/objectId.js";

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
