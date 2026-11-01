/**
 * Phase 2 verification script — NOT part of the runtime server.
 * Run with: npm run verify:models
 *
 * Connects to a temporary throwaway database (booknook_model_verification),
 * creates collections/indexes, exercises the query helpers with temporary
 * documents, then drops the database so no test data ever lingers.
 */
import { MongoClient, ObjectId } from "mongodb";
import { closeDB } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import {
  BOOKS_COLLECTION,
  BORROWS_COLLECTION,
  getBooksCollection,
  getBorrowsCollection,
} from "../src/config/collections.js";
import { ensureIndexes } from "../src/config/indexes.js";
import {
  findBookById,
  insertBook,
  listBooks,
  releaseOneCopy,
  reserveOneCopy,
  updateBookById,
} from "../src/repositories/book.repository.js";
import {
  countActiveBorrowsByUser,
  findBorrowById,
  findOverdueBorrows,
  hasActiveBorrow,
  insertBorrow,
  listBorrowsByUser,
  markBorrowReturned,
} from "../src/repositories/borrow.repository.js";

const TEST_DB = "booknook_model_verification";

let passed = 0;
let failed = 0;

const check = (label: string, condition: boolean, detail = ""): void => {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const run = async (): Promise<void> => {
  // Use a temporary database so nothing lands in the real one
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);

  const books = getBooksCollection(db);
  const borrows = getBorrowsCollection(db);

  console.log("\n1) Collection access");
  await ensureIndexes(db);
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  check("books collection accessible", collections.includes(BOOKS_COLLECTION));
  check("borrows collection accessible", collections.includes(BORROWS_COLLECTION));

  console.log("\n2) Indexes");
  const bookIndexes = (await books.indexes()).map((i) => i.name);
  const borrowIndexes = (await borrows.indexes()).map((i) => i.name);
  for (const name of ["books_added_by", "books_category", "books_created_at_desc", "books_text_search"]) {
    check(`book index "${name}" exists`, bookIndexes.includes(name));
  }
  for (const name of [
    "borrows_user_history",
    "borrows_book_status",
    "borrows_one_active_per_user_book",
    "borrows_status_return_date",
    "borrows_user_email",
  ]) {
    check(`borrow index "${name}" exists`, borrowIndexes.includes(name));
  }
  const partial = (await borrows.indexes()).find((i) => i.name === "borrows_one_active_per_user_book");
  check("partial unique index on active borrows", partial?.unique === true && partial?.partialFilterExpression !== undefined);

  console.log("\n3) Book query helpers (temporary documents)");
  const book = await insertBook(books, {
    title: "Verification Test Book",
    author: "Test Author",
    category: "Fiction",
    image: "https://example.com/cover.jpg",
    description: "Temporary document used only for verification.",
    addedBy: "auth-user-uid-123",
    addedByName: "Test User",
    addedByEmail: "test@example.com",
    totalCopies: 2,
    availableCopies: 2,
  });
  check("insertBook returns stored doc with _id/dates", Boolean(book._id && book.createdAt && book.updatedAt));

  const foundById = await findBookById(books, book._id.toString());
  check("findBookById finds the book", foundById?.title === "Verification Test Book");
  check("findBookById with invalid id returns null", (await findBookById(books, "not-an-id")) === null);
  check("findBookById with random valid ObjectId returns null", (await findBookById(books, new ObjectId().toString())) === null);

  const { books: listed, total } = await listBooks(books, { search: "verification", addedBy: "auth-user-uid-123" }, { limit: 5 });
  check("listBooks with search+owner filter", total === 1 && listed[0]?._id.equals(book._id));

  const categoryFiltered = await listBooks(books, { category: "Science" });
  check("listBooks filters by category", categoryFiltered.total === 0);

  const updated = await updateBookById(books, book._id.toString(), { description: "Updated during verification" });
  check("updateBookById updates fields", updated?.description === "Updated during verification");

  const reserved = await reserveOneCopy(books, book._id.toString());
  check("reserveOneCopy decrements availableCopies", reserved?.availableCopies === 1);
  await reserveOneCopy(books, book._id.toString());
  const exhausted = await reserveOneCopy(books, book._id.toString());
  check("reserveOneCopy blocks when no copies left", exhausted === null);

  const released = await releaseOneCopy(books, book._id.toString());
  check("releaseOneCopy restores a copy", released?.availableCopies === 1);

  console.log("\n4) Borrow query helpers (temporary documents)");
  const borrow = await insertBorrow(borrows, {
    bookId: book._id,
    bookTitle: book.title,
    bookImage: book.image,
    userId: "auth-user-uid-123",
    userName: "Test User",
    userEmail: "test@example.com",
  });
  check("insertBorrow defaults: borrowed status, null returnedAt", borrow.status === "borrowed" && borrow.returnedAt === null);
  check("insertBorrow sets ~14 day returnDate", Math.abs(borrow.returnDate.getTime() - borrow.borrowDate.getTime() - 14 * 86_400_000) < 1000);

  const foundBorrow = await findBorrowById(borrows, borrow._id.toString());
  check("findBorrowById finds the record", foundBorrow?.bookTitle === "Verification Test Book");
  check("findBorrowById with invalid id returns null", (await findBorrowById(borrows, "xyz")) === null);

  check("hasActiveBorrow is true while borrowed", await hasActiveBorrow(borrows, "auth-user-uid-123", book._id));
  check("countActiveBorrowsByUser", (await countActiveBorrowsByUser(borrows, "auth-user-uid-123")) === 1);

  const { borrows: userBorrows, total: userTotal } = await listBorrowsByUser(borrows, { userId: "auth-user-uid-123", status: "borrowed" });
  check("listBorrowsByUser with status filter", userTotal === 1 && userBorrows[0]?._id.equals(borrow._id));

  const overdue = await findOverdueBorrows(borrows, new Date(Date.now() + 30 * 86_400_000));
  check("findOverdueBorrows detects past-deadline borrows", overdue.some((b) => b._id.equals(borrow._id)));

  const returned = await markBorrowReturned(borrows, borrow._id.toString());
  check("markBorrowReturned sets status+returnedAt", returned?.status === "returned" && returned?.returnedAt instanceof Date);
  check("markBorrowReturned is idempotent-safe", (await markBorrowReturned(borrows, borrow._id.toString())) === null);
  check("hasActiveBorrow is false after return", !(await hasActiveBorrow(borrows, "auth-user-uid-123", book._id)));

  // Cleanup: drop the temporary database so no test data remains
  await client.db(TEST_DB).dropDatabase();
  await client.close();
  await closeDB().catch(() => undefined);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

run().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n❌ Verification failed: ${message}`);
  await closeDB().catch(() => undefined);
  process.exit(1);
});
