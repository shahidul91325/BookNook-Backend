import {
  ObjectId,
  type Collection,
  type Filter,
  type UpdateFilter,
} from "mongodb";
import type { Book, BookListFilter, CreateBookInput } from "../models/book.model.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { toObjectId } from "../utils/objectId.js";

export type BookListOptions = {
  skip?: number;
  limit?: number;
};

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
  const { skip = 0, limit = 20 } = options;

  const [items, total] = await Promise.all([
    books
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    books.countDocuments(query),
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
