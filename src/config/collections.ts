import type { Collection, Db } from "mongodb";
import type { Book } from "../models/book.model.js";
import type { Borrow } from "../models/borrow.model.js";

export const BOOKS_COLLECTION = "books";
export const BORROWS_COLLECTION = "borrows";

/** Typed accessor for the `books` collection. */
export const getBooksCollection = (db: Db): Collection<Book> =>
  db.collection<Book>(BOOKS_COLLECTION);

/** Typed accessor for the `borrows` collection. */
export const getBorrowsCollection = (db: Db): Collection<Borrow> =>
  db.collection<Borrow>(BORROWS_COLLECTION);
