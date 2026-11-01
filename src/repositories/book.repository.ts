import {
  ObjectId,
  type Collection,
  type Filter,
  type Sort,
  type UpdateFilter,
} from "mongodb";
import type {
  Book,
  BookListFilter,
  BookSort,
  CreateBookInput,
} from "../models/book.model.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { toObjectId } from "../utils/objectId.js";

export type BookListOptions = {
  skip?: number;
  limit?: number;
  /** Sort mode; defaults to `newest` (createdAt descending). */
  sort?: BookSort;
};

/** Case-insensitive ordering for title sorts (A→Z regardless of casing). */
const TITLE_COLLATION = { locale: "en", strength: 2 } as const;

const SORT_SPECIFIERS: Record<BookSort, Sort> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  "title-asc": { title: 1 },
  "title-desc": { title: -1 },
  "quantity-desc": { totalCopies: -1 },
};

const getSortSpecifier = (sort?: BookSort): Sort =>
  SORT_SPECIFIERS[sort ?? "newest"] ?? SORT_SPECIFIERS.newest;

const buildBookFilter = (filter: BookListFilter): Filter<Book> => {
  const query: Filter<Book> = {};

  if (filter.category) {
    query.category = filter.category;
  }
  if (filter.addedBy) {
    query.addedBy = filter.addedBy;
  }
  if (filter.search) {
    const pattern = new RegExp(escapeRegex(filter.search.trim()), "i");
    query.$or = [{ title: pattern }, { author: pattern }];
  }

  return query;
};

/** Finds a book by id string or ObjectId. Returns null for invalid ids. */
export const findBookById = async (
  books: Collection<Book>,
  id: string | ObjectId
): Promise<Book | null> => {
  const objectId = typeof id === "string" ? toObjectId(id) : id;
  if (!objectId) return null;
  return books.findOne({ _id: objectId });
};

/** Lists books with optional filters + pagination, sorted newest first. */
export const listBooks = async (
  books: Collection<Book>,
  filter: BookListFilter = {},
  options: BookListOptions = {}
): Promise<{ books: Book[]; total: number }> => {
  const query = buildBookFilter(filter);
  const { skip = 0, limit = 20, sort } = options;
  const usesTitleCollation = sort === "title-asc" || sort === "title-desc";

  const findCursor = books.find(query);
  if (usesTitleCollation) findCursor.collation(TITLE_COLLATION);

  const [items, total] = await Promise.all([
    findCursor.sort(getSortSpecifier(sort)).skip(skip).limit(limit).toArray(),
    books.countDocuments(
      query,
      usesTitleCollation ? { collation: TITLE_COLLATION } : undefined
    ),
  ]);

  return { books: items, total };
};

/** Fetches many books by their ids (for borrow lists). */
export const findBooksByIds = async (
  books: Collection<Book>,
  ids: ObjectId[]
): Promise<Book[]> => books.find({ _id: { $in: ids } }).toArray();

/** Inserts a new book and returns the stored document. */
export const insertBook = async (
  books: Collection<Book>,
  input: CreateBookInput
): Promise<Book> => {
  const now = new Date();
  const book: Book = { ...input, _id: new ObjectId(), createdAt: now, updatedAt: now };
  await books.insertOne(book);
  return book;
};

/** Updates editable book fields and refreshes `updatedAt`. */
export const updateBookById = async (
  books: Collection<Book>,
  id: string,
  update: Partial<CreateBookInput>
): Promise<Book | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return books.findOneAndUpdate(
    { _id: objectId },
    { $set: { ...update, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
};

/**
 * Updates a book ONLY if it still belongs to `ownerId`.
 *
 * The ownership condition lives inside the query itself, so even if the
 * controller's pre-check raced with another request, MongoDB will never
 * modify another user's document. `update` must already exclude ownership
 * and server-managed fields (built from the parsed Zod payload).
 * Returns the updated document, or null when not found / not owned.
 */
export const updateBookForOwner = async (
  books: Collection<Book>,
  id: string,
  ownerId: string,
  update: Partial<CreateBookInput>
): Promise<Book | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return books.findOneAndUpdate(
    { _id: objectId, addedBy: ownerId },
    { $set: { ...update, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
};

/**
 * Deletes a book ONLY if it still belongs to `ownerId` (same query-level
 * ownership guard as `updateBookForOwner`).
 * Returns true when a document was actually deleted.
 */
export const deleteBookForOwner = async (
  books: Collection<Book>,
  id: string,
  ownerId: string
): Promise<boolean> => {
  const objectId = toObjectId(id);
  if (!objectId) return false;

  const result = await books.deleteOne({ _id: objectId, addedBy: ownerId });
  return result.deletedCount === 1;
};

/** Atomically reserves one copy. Returns null if no copy is available. */
export const reserveOneCopy = async (
  books: Collection<Book>,
  id: string
): Promise<Book | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return books.findOneAndUpdate(
    { _id: objectId, availableCopies: { $gt: 0 } },
    { $inc: { availableCopies: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
};

/** Atomically releases one copy, clamped so it never exceeds totalCopies. */
export const releaseOneCopy = async (
  books: Collection<Book>,
  id: string
): Promise<Book | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return books.findOneAndUpdate(
    { _id: objectId },
    [
      {
        $set: {
          availableCopies: {
            $min: ["$totalCopies", { $add: ["$availableCopies", 1] }],
          },
          updatedAt: new Date(),
        },
      },
    ],
    { returnDocument: "after" }
  );
};
