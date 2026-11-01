import {
  ObjectId,
  type Collection,
  type Filter,
} from "mongodb";
import type {
  Borrow,
  BorrowListFilter,
  CreateBorrowInput,
} from "../models/borrow.model.js";
import { toObjectId } from "../utils/objectId.js";

const DEFAULT_BORROW_DAYS = 14;

export type BorrowListOptions = {
  skip?: number;
  limit?: number;
};

/** Inserts a new borrow record in `borrowed` status. */
export const insertBorrow = async (
  borrows: Collection<Borrow>,
  input: CreateBorrowInput
): Promise<Borrow> => {
  const now = new Date();
  const borrow: Borrow = {
    _id: new ObjectId(),
    bookId: input.bookId,
    bookTitle: input.bookTitle,
    bookImage: input.bookImage,
    userId: input.userId,
    userName: input.userName,
    userEmail: input.userEmail,
    borrowDate: now,
    returnDate: input.returnDate ?? new Date(now.getTime() + DEFAULT_BORROW_DAYS * 86_400_000),
    returnedAt: null,
    status: "borrowed",
  };
  await borrows.insertOne(borrow);
  return borrow;
};

/** Finds a borrow record by id string or ObjectId. */
export const findBorrowById = async (
  borrows: Collection<Borrow>,
  id: string | ObjectId
): Promise<Borrow | null> => {
  const objectId = typeof id === "string" ? toObjectId(id) : id;
  if (!objectId) return null;
  return borrows.findOne({ _id: objectId });
};

/** Lists a user's borrows (optionally filtered by status), newest first. */
export const listBorrowsByUser = async (
  borrows: Collection<Borrow>,
  filter: BorrowListFilter,
  options: BorrowListOptions = {}
): Promise<{ borrows: Borrow[]; total: number }> => {
  const query: Filter<Borrow> = { userId: filter.userId };
  if (filter.status) {
    query.status = filter.status;
  }

  const { skip = 0, limit = 20 } = options;

  const [items, total] = await Promise.all([
    borrows
      .find(query)
      .sort({ borrowDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    borrows.countDocuments(query),
  ]);

  return { borrows: items, total };
};

/** Counts a user's currently active (not yet returned) borrows. */
export const countActiveBorrowsByUser = async (
  borrows: Collection<Borrow>,
  userId: string
): Promise<number> =>
  borrows.countDocuments({ userId, status: "borrowed" });

/** Lists active (still borrowed) records for a book. */
export const findActiveBorrowsByBook = async (
  borrows: Collection<Borrow>,
  bookId: ObjectId
): Promise<Borrow[]> =>
  borrows.find({ bookId, status: "borrowed" }).toArray();

/** Counts active (still borrowed) records for a book. */
export const countActiveBorrowsByBook = async (
  borrows: Collection<Borrow>,
  bookId: ObjectId
): Promise<number> =>
  borrows.countDocuments({ bookId, status: "borrowed" });

/**
 * Deletes every borrow record that references a book.
 * Called when the book itself is deleted so no orphaned records
 * (pointing at a nonexistent bookId) are ever left behind.
 */
export const deleteBorrowsByBook = async (
  borrows: Collection<Borrow>,
  bookId: ObjectId
): Promise<number> => {
  const result = await borrows.deleteMany({ bookId });
  return result.deletedCount;
};

/** True if the user already has an active borrow of this book. */
export const hasActiveBorrow = async (
  borrows: Collection<Borrow>,
  userId: string,
  bookId: ObjectId
): Promise<boolean> => {
  const existing = await borrows.findOne({ userId, bookId, status: "borrowed" });
  return existing !== null;
};

/**
 * Marks a borrow as returned (sets status + returnedAt).
 * Returns null if not found or already returned.
 */
export const markBorrowReturned = async (
  borrows: Collection<Borrow>,
  id: string
): Promise<Borrow | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return borrows.findOneAndUpdate(
    { _id: objectId, status: "borrowed" },
    { $set: { status: "returned", returnedAt: new Date() } },
    { returnDocument: "after" }
  );
};

/** Finds overdue borrows: still borrowed and past their return date. */
export const findOverdueBorrows = async (
  borrows: Collection<Borrow>,
  now: Date = new Date()
): Promise<Borrow[]> =>
  borrows.find({ status: "borrowed", returnDate: { $lt: now } }).toArray();
