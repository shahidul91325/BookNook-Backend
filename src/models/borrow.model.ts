import type { ObjectId } from "mongodb";

export type BorrowStatus = "borrowed" | "returned";

/**
 * A Borrow record stored in the `borrows` collection.
 *
 * `userId` is the stable authenticated user id from the auth provider.
 * Denormalized `bookTitle` / `bookImage` / user info keep list queries fast
 * (no join needed).
 */
export type Borrow = {
  _id: ObjectId;
  bookId: ObjectId;
  bookTitle: string;
  bookImage: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** When the book was borrowed */
  borrowDate: Date;
  /** Expected return deadline */
  returnDate: Date;
  /** Actual return time, null while the book is still borrowed */
  returnedAt: Date | null;
  status: BorrowStatus;
};

/** Payload accepted when creating a borrow record (server fills in the rest). */
export type CreateBorrowInput = Omit<
  Borrow,
  "_id" | "borrowDate" | "returnedAt" | "status" | "returnDate"
> & {
  /** Optional deadline override, defaults to 14 days from now */
  returnDate?: Date;
};

/** Filters for listing a user's borrows. */
export type BorrowListFilter = {
  userId: string;
  status?: BorrowStatus;
};

/**
 * The public API representation of a borrow record.
 * `id` is the frontend-compatible alias of `_id`.
 */
export type BorrowResponse = {
  id: string;
  /** MongoDB id of the borrowed book (as a string). */
  bookId: string;
  /** Denormalized book info so the list needs no join. */
  bookTitle: string;
  bookImage: string;
  /** Stable authenticated user id of the borrower. */
  userId: string;
  userName: string;
  userEmail: string;
  borrowDate: Date;
  /** Expected return deadline. */
  returnDate: Date;
  /** Actual return time, null while still borrowed. */
  returnedAt: Date | null;
  status: BorrowStatus;
};

/** Maps a stored borrow document to its public API representation. */
export const toBorrowResponse = (doc: Borrow): BorrowResponse => ({
  id: doc._id.toString(),
  bookId: doc.bookId.toString(),
  bookTitle: doc.bookTitle,
  bookImage: doc.bookImage,
  userId: doc.userId,
  userName: doc.userName,
  userEmail: doc.userEmail,
  borrowDate: doc.borrowDate,
  returnDate: doc.returnDate,
  returnedAt: doc.returnedAt,
  status: doc.status,
});
