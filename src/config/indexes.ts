import type { Db } from "mongodb";
import { getBooksCollection, getBorrowsCollection } from "./collections.js";

/**
 * Creates the collections (if missing) and their indexes.
 * Safe to run on every boot — createIndex is idempotent.
 */
export const ensureIndexes = async (db: Db): Promise<void> => {
  const books = getBooksCollection(db);
  await Promise.all([
    // Ownership: "books added by this user"
    books.createIndex({ addedBy: 1 }, { name: "books_added_by" }),
    // Frequent filter: browse by category
    books.createIndex({ category: 1 }, { name: "books_category" }),
    // Frequent sort: newest first
    books.createIndex({ createdAt: -1 }, { name: "books_created_at_desc" }),
    // Full-text search over title and author
    books.createIndex(
      { title: "text", author: "text" },
      { name: "books_text_search" }
    ),
  ]);

  const borrows = getBorrowsCollection(db);
  await Promise.all([
    // A user's borrow history, newest first
    borrows.createIndex(
      { userId: 1, createdAt: -1 },
      { name: "borrows_user_history" }
    ),
    // Active borrows of a book (for availableCopies logic)
    borrows.createIndex(
      { bookId: 1, status: 1 },
      { name: "borrows_book_status" }
    ),
    // One active borrow per user per book (partial unique index)
    borrows.createIndex(
      { userId: 1, bookId: 1 },
      {
        name: "borrows_one_active_per_user_book",
        unique: true,
        partialFilterExpression: { status: "borrowed" },
      }
    ),
    // Overdue queries: borrowed books past their return date
    borrows.createIndex(
      { status: 1, returnDate: 1 },
      { name: "borrows_status_return_date" }
    ),
    // Lookup by user email
    borrows.createIndex({ userEmail: 1 }, { name: "borrows_user_email" }),
  ]);

  console.log("✅ MongoDB collections and indexes ensured");
};
