import {
  ObjectId,
  type ClientSession,
  type Collection,
  type Filter,
} from "mongodb";
import type {
  Borrow,
  BorrowListFilter,
  CreateBorrowInput,
} from "../models/borrow.model.js";
import { toObjectId } from "../utils/objectId.js";

/** Default lending period when the borrower does not request one. */
export const DEFAULT_BORROW_DAYS = 14;
/** Hard server-side cap on how far ahead a return deadline may be set. */
export const MAX_BORROW_DAYS = 30;

export type BorrowListOptions = {
  skip?: number;
  limit?: number;
};

/**
 * Inserts a new borrow record in `borrowed` status.
 * `borrowDate`/`returnDate` are generated on the SERVER: the deadline is
 * the validated client request if given, else `DEFAULT_BORROW_DAYS` out.
 * Pass `session` to enroll the insert in a surrounding transaction.
 */
export const insertBorrow = async (
  borrows: Collection<Borrow>,
  input: CreateBorrowInput,
  session?: ClientSession
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
  await borrows.insertOne(borrow, session ? { session } : undefined);
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
 * Marks a borrow as returned (sets status + returnedAt) with an ATOMIC
 * conditional flip: only a record still in `borrowed` status matches, so
 * concurrent return requests can restore the copy exactly once.
 * Returns null when not found or already returned.
 * Pass `session` to enroll the update in a surrounding transaction.
 */
export const markBorrowReturned = async (
  borrows: Collection<Borrow>,
  id: string,
  session?: ClientSession
): Promise<Borrow | null> => {
  const objectId = toObjectId(id);
  if (!objectId) return null;

  return borrows.findOneAndUpdate(
    { _id: objectId, status: "borrowed" },
    { $set: { status: "returned", returnedAt: new Date() } },
    { returnDocument: "after", ...(session ? { session } : {}) }
  );
};

/** Finds overdue borrows: still borrowed and past their return date. */
export const findOverdueBorrows = async (
  borrows: Collection<Borrow>,
  now: Date = new Date()
): Promise<Borrow[]> =>
  borrows.find({ status: "borrowed", returnDate: { $lt: now } }).toArray();
