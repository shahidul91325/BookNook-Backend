import type { ObjectId } from "mongodb";

/**
 * A Book document stored in the `books` collection.
 *
 * Ownership (`addedBy`) stores the stable authenticated user id from the
 * auth provider (e.g. Firebase UID / NextAuth user id) as a string, so any
 * uid format works without ObjectId casting problems.
 */
export type Book = {
  _id: ObjectId;
  title: string;
  author: string;
  category: string;
  image: string;
  description: string;
  /** Stable authenticated user id of the user who added the book */
  addedBy: string;
  addedByName: string;
  addedByEmail: string;
  totalCopies: number;
  availableCopies: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Payload accepted when creating a book (server fills in the rest). */
export type CreateBookInput = Omit<Book, "_id" | "createdAt" | "updatedAt">;

/** Optional filters for listing/searching books. */
export type BookListFilter = {
  /** Matches title, author, or category (case-insensitive, regex-safe) */
  search?: string;
  category?: string;
  /** Filter by the user who added the book */
  addedBy?: string;
};

/**
 * Supported sort modes for the public catalog, mirroring the values the
 * frontend sends in its `sort` query parameter.
 */
export type BookSort =
  /** createdAt descending (default) */
  | "newest"
  /** createdAt ascending */
  | "oldest"
  /** title A→Z (case-insensitive) */
  | "title-asc"
  /** title Z→A (case-insensitive) */
  | "title-desc"
  /** totalCopies descending */
  | "quantity-desc";

/**
 * The public API representation of a book.
 *
 * `quantity`, `userName`, and `userEmail` are the frontend-compatible
 * aliases of `totalCopies`, `addedByName`, and `addedByEmail`.
 */
export type BookResponse = {
  id: string;
  title: string;
  author: string;
  category: string;
  image: string;
  description: string;
  /** Total copies submitted for this book (= `totalCopies`). */
  quantity: number;
  totalCopies: number;
  /** Copies currently available to borrow. */
  availableCopies: number;
  /** Stable authenticated user id of the user who added the book. */
  addedBy: string;
  /** Display name of the user who added the book. */
  userName: string;
  /** Email of the user who added the book. */
  userEmail: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Maps a stored book document to its public API representation. */
export const toBookResponse = (doc: Book): BookResponse => ({
  id: doc._id.toString(),
  title: doc.title,
  author: doc.author,
  category: doc.category,
  image: doc.image,
  description: doc.description,
  quantity: doc.totalCopies,
  totalCopies: doc.totalCopies,
  availableCopies: doc.availableCopies,
  addedBy: doc.addedBy,
  userName: doc.addedByName,
  userEmail: doc.addedByEmail,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});
