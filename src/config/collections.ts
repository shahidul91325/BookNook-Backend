import type { Collection, Db } from "mongodb";
import type { Book } from "../models/book.model.js";
import type { Borrow } from "../models/borrow.model.js";
import type { BetterAuthSession, BetterAuthUser } from "../models/auth.model.js";

export const BOOKS_COLLECTION = "books";
export const BORROWS_COLLECTION = "borrows";

/**
 * Better Auth (v1.7.14, mongodbAdapter) owns these collections. API identity
 * lookups read the user collection; session and account writes are handled by
 * Better Auth's adapter, never by REST controllers.
 */
export const BETTER_AUTH_USER_COLLECTION = "user";
export const BETTER_AUTH_SESSION_COLLECTION = "session";

/** Typed accessor for the `books` collection. */
export const getBooksCollection = (db: Db): Collection<Book> =>
  db.collection<Book>(BOOKS_COLLECTION);

/** Typed accessor for the `borrows` collection. */
export const getBorrowsCollection = (db: Db): Collection<Borrow> =>
  db.collection<Borrow>(BORROWS_COLLECTION);

/** Typed accessor for Better Auth's `user` collection (read-only). */
export const getAuthUsersCollection = (db: Db): Collection<BetterAuthUser> =>
  db.collection<BetterAuthUser>(BETTER_AUTH_USER_COLLECTION);

/** Typed accessor for Better Auth's `session` collection (read-only). */
export const getAuthSessionsCollection = (
  db: Db
): Collection<BetterAuthSession> =>
  db.collection<BetterAuthSession>(BETTER_AUTH_SESSION_COLLECTION);
