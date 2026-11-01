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
export type CreateBorrowInput = Omit<Borrow, "_id" | "borrowDate" | "returnedAt" | "status"> & {
  /** Optional deadline override, defaults to 14 days from now */
  returnDate?: Date;
};

/** Filters for listing a user's borrows. */
export type BorrowListFilter = {
  userId: string;
  status?: BorrowStatus;
};
