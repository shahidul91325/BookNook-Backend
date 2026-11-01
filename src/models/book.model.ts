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
  /** Matches title or author (case-insensitive, regex-safe) */
  search?: string;
  category?: string;
  /** Filter by the user who added the book */
  addedBy?: string;
};
