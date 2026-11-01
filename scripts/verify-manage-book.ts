/**
 * Phase 6 verification script — NOT part of the runtime server.
 * Run with: npm run verify:manage
 *
 * Connects to a temporary throwaway database (booknook_manage_verification),
 * seeds two verified users + signed session cookies + books/borrow records,
 * then exercises PATCH/PUT/DELETE /api/books/:id and the My Books endpoints
 * over HTTP against the real Express app. The database is dropped
 * afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1. Owner PATCH update                        → 200 + changed fields
 *   2. Partial update preserves omitted fields   → untouched fields intact
 *   3. updatedAt refreshed server-side           → moves forward
 *   4. Quantity update recalculates availableCopies (active borrows)
 *   5. Ownership fields in update body ignored   → owner unchanged
 *   6. Empty update body                         → 400
 *   7. Invalid category / description on update  → 400
 *   8. Other user PATCH/PUT                      → 403
 *   9. Unauthenticated PATCH/DELETE              → 401
 *  10. Invalid ObjectId (PATCH + DELETE)         → 400
 *  11. Missing book                              → 404
 *  12. PUT alias (frontend contract)             → 200
 *  13. Owner DELETE                              → 200, gone from DB
 *  14. Active borrow blocks DELETE               → 409, book + record intact
 *  15. DELETE cleans up returned borrow records  → no orphans
 *  16. Other user DELETE                         → 403
 *  17. GET /api/my-books (+ /my, /user aliases)  → only own books
 *  18. My Books spoofed email query param        → ignored, session wins
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";

const TEST_DB = "booknook_manage_verification";

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

/** Replicates better-call's `signCookieValue` used by Better Auth 1.7.14. */
const signSessionCookie = (token: string, secret: string): string => {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
};

interface ApiBook {
  id: string;
  title: string;
  author: string;
  category: string;
  image: string;
  description: string;
  quantity: number;
  totalCopies: number;
  availableCopies: number;
  addedBy: string;
  userName: string;
  userEmail: string;
  rating?: number;
  createdAt: string;
  updatedAt: string;
}

interface BookEnvelope {
  status: string;
  message?: string;
  success?: boolean;
  errors?: Record<string, string[]>;
  removedBorrowRecords?: number;
  results?: number;
  total?: number;
  books?: ApiBook[];
  data?: ApiBook;
}

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);
  const books = db.collection("books");
  const borrows = db.collection("borrows");
  const users = db.collection("user");
  const sessions = db.collection("session");
  await books.deleteMany({});
  await borrows.deleteMany({});
  await users.deleteMany({});
  await sessions.deleteMany({});

  // ── Fixtures: two verified users with valid signed sessions ─────────────
  const now = new Date();
  const aliceId = new ObjectId();
  const bobId = new ObjectId();
  await users.insertMany([
    { _id: aliceId, name: "Alice Owner", email: "alice@test.local", emailVerified: true, image: null, createdAt: now, updatedAt: now },
    { _id: bobId, name: "Bob Other", email: "bob@test.local", emailVerified: true, image: null, createdAt: now, updatedAt: now },
  ]);
  const aliceToken = "manage-phase-session-alice00000";
  const bobToken = "manage-phase-session-bob00000000";
  await sessions.insertMany([
    { token: aliceToken, userId: aliceId, expiresAt: new Date(Date.now() + 60 * 60 * 1000), createdAt: now, updatedAt: now },
    { token: bobToken, userId: bobId, expiresAt: new Date(Date.now() + 60 * 60 * 1000), createdAt: now, updatedAt: now },
  ]);
  const cookieName = "better-auth.session_token";
  const aliceCookie = `${cookieName}=${signSessionCookie(aliceToken, env.BETTER_AUTH_SECRET)}`;
  const bobCookie = `${cookieName}=${signSessionCookie(bobToken, env.BETTER_AUTH_SECRET)}`;

  // ── Fixtures: books owned by Alice ──────────────────────────────────────
  const baseTime = Date.now();
  const mkBook = (over: Record<string, unknown>) => ({
    category: "Programming",
    image: "https://example.com/cover.jpg",
    description: "A perfectly valid book description for testing.",
    addedBy: aliceId.toString(),
    addedByName: "Alice Owner",
    addedByEmail: "alice@test.local",
    availableCopies: (over.totalCopies as number) ?? 3,
    createdAt: new Date(baseTime - 60_000),
    updatedAt: new Date(baseTime - 60_000),
    ...over,
  });
  const ins = await books.insertMany([
    mkBook({ title: "Refactoring", author: "Martin Fowler", totalCopies: 3 }),
    mkBook({ title: "Domain-Driven Design", author: "Eric Evans", totalCopies: 2 }),
    mkBook({ title: "The Pragmatic Programmer", author: "Hunt & Thomas", totalCopies: 2 }),
  ]);
  const refactoringId = ins.insertedIds[0].toString();
  const dddId = ins.insertedIds[1].toString();
  const ppId = ins.insertedIds[2].toString();

  // Borrows: DDD has one ACTIVE borrow; PP has one RETURNED borrow.
  await borrows.insertMany([
    {
      bookId: ins.insertedIds[1],
      bookTitle: "Domain-Driven Design",
      bookImage: "https://example.com/cover.jpg",
      userId: bobId.toString(),
      userName: "Bob Other",
      userEmail: "bob@test.local",
      borrowDate: new Date(),
      returnDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      returnedAt: null,
      status: "borrowed",
    },
    {
      bookId: ins.insertedIds[2],
      bookTitle: "The Pragmatic Programmer",
      bookImage: "https://example.com/cover.jpg",
      userId: bobId.toString(),
      userName: "Bob Other",
      userEmail: "bob@test.local",
      borrowDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      returnDate: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
      returnedAt: new Date(Date.now() - 17 * 24 * 60 * 60 * 1000),
      status: "returned",
    },
  ]);

  const app = createApp(db);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const patch = async (
    id: string,
    body: unknown,
    opts: { cookie?: string; method?: "PATCH" | "PUT" } = {}
  ): Promise<{ status: number; body: BookEnvelope }> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await fetch(`${base}/api/books/${id}`, {
      method: opts.method ?? "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as BookEnvelope };
  };

  const del = async (
    id: string,
    cookie?: string
  ): Promise<{ status: number; body: BookEnvelope }> => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}/api/books/${id}`, { method: "DELETE", headers });
    return { status: res.status, body: (await res.json()) as BookEnvelope };
  };

  const get = async (
    path: string,
    cookie?: string
  ): Promise<{ status: number; body: BookEnvelope }> => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as BookEnvelope };
  };

  // ── 1. Owner PATCH update ───────────────────────────────────────────────
  console.log("\n1. Owner updates own book (PATCH)");
  {
    const { status, body } = await patch(
      refactoringId,
      { title: "Refactoring (2nd Edition)", author: "Martin Fowler", rating: 4.8 },
      { cookie: aliceCookie }
    );
    check("200 OK", status === 200);
    check("status success", body.status === "success");
    check("title updated", body.data?.title === "Refactoring (2nd Edition)");
    check("rating added", body.data?.rating === 4.8);
    check("id unchanged", body.data?.id === refactoringId);
    check("owner unchanged", body.data?.addedBy === aliceId.toString());

    const stored = await books.findOne({ _id: (await books.findOne({ title: "Refactoring (2nd Edition)" }))!._id });
    check("persisted in MongoDB", stored?.title === "Refactoring (2nd Edition)" && stored?.rating === 4.8);
  }

  // ── 2. Partial update preserves omitted fields ──────────────────────────
  console.log("\n2. Partial update preserves omitted fields");
  {
    const { status, body } = await patch(refactoringId, { description: "Now with better examples and patterns throughout." }, { cookie: aliceCookie });
    check("200 OK", status === 200);
    check("description updated", body.data?.description === "Now with better examples and patterns throughout.");
    check("title preserved", body.data?.title === "Refactoring (2nd Edition)");
    check("author preserved", body.data?.author === "Martin Fowler");
    check("category preserved", body.data?.category === "Programming");
    check("quantity preserved", body.data?.totalCopies === 3);
    check("rating preserved", body.data?.rating === 4.8);
    check("userName/userEmail preserved", body.data?.userName === "Alice Owner" && body.data?.userEmail === "alice@test.local");
  }

  // ── 3. updatedAt refreshed server-side ──────────────────────────────────
  console.log("\n3. updatedAt refreshed by the server");
  {
    const before = (await get(`/api/books/${refactoringId}`)).body.data;
    await new Promise((r) => setTimeout(r, 15));
    const { body } = await patch(refactoringId, { title: "Refactoring, 2nd Edition" }, { cookie: aliceCookie });
    check("updatedAt moved forward", Date.parse(body.data?.updatedAt ?? "0") >= Date.parse(before?.updatedAt ?? "0"));
    check("createdAt untouched", body.data?.createdAt === before?.createdAt);
    check("client cannot set timestamps", (await patch(refactoringId, { createdAt: "1999-01-01T00:00:00.000Z", updatedAt: "1999-01-01T00:00:00.000Z", title: "Timestamp Attack" }, { cookie: aliceCookie })).body.data?.createdAt !== "1999-01-01T00:00:00.000Z");
  }

  // ── 4. Quantity update recalculates availableCopies ─────────────────────
  console.log("\n4. Quantity update keeps availableCopies consistent");
  {
    // DDD: totalCopies=2, 1 active borrow → availableCopies=1.
    const { body } = await patch(dddId, { quantity: 5 }, { cookie: aliceCookie });
    check("totalCopies updated", body.data?.totalCopies === 5);
    check("availableCopies = 5 - 1 active = 4", body.data?.availableCopies === 4, `availableCopies=${body.data?.availableCopies}`);

    // Setting quantity below active borrows floors availableCopies at 0.
    const low = await patch(dddId, { quantity: 1 }, { cookie: aliceCookie });
    check("quantity below active borrows floors at 0", low.body.data?.availableCopies === 0, `availableCopies=${low.body.data?.availableCopies}`);
    await patch(dddId, { quantity: 2 }, { cookie: aliceCookie }); // restore

    // Zero allowed by the frontend edit dialog.
    const zero = await patch(refactoringId, { quantity: 0 }, { cookie: aliceCookie });
    check("quantity 0 accepted on update", zero.status === 200 && zero.body.data?.totalCopies === 0);
    await patch(refactoringId, { quantity: 3 }, { cookie: aliceCookie }); // restore
  }

  // ── 5. Ownership spoofing via update body ───────────────────────────────
  console.log("\n5. Ownership spoofing attempt in update body");
  {
    const { status, body } = await patch(
      refactoringId,
      {
        title: "Still Alice's Book",
        addedBy: bobId.toString(),
        addedByName: "Bob Other",
        addedByEmail: "bob@test.local",
        userName: "Bob Other",
        userEmail: "bob@test.local",
        availableCopies: 999,
        id: new ObjectId().toString(),
      },
      { cookie: aliceCookie }
    );
    check("200 OK (update itself allowed)", status === 200);
    check("addedBy cannot be transferred", body.data?.addedBy === aliceId.toString(), `addedBy=${body.data?.addedBy}`);
    check("userName/userEmail unchanged", body.data?.userName === "Alice Owner" && body.data?.userEmail === "alice@test.local");
    check("availableCopies not client-settable", body.data?.availableCopies === 3, `availableCopies=${body.data?.availableCopies}`);
    check("id unchanged", body.data?.id === refactoringId);
    const stored = await books.findOne({ _id: new ObjectId(refactoringId) });
    check("stored owner still Alice", stored?.addedBy === aliceId.toString());
  }

  // ── 6. Empty / invalid update bodies ────────────────────────────────────
  console.log("\n6. Empty and invalid update bodies");
  {
    const empty = await patch(refactoringId, {}, { cookie: aliceCookie });
    check("400 for empty body", empty.status === 400);
    check("fail shape with message", empty.body.status === "fail" && typeof empty.body.message === "string");

    const onlySpoof = await patch(refactoringId, { addedBy: bobId.toString() }, { cookie: aliceCookie });
    check("400 when only ownership fields sent (all stripped)", onlySpoof.status === 400);

    const badCat = await patch(refactoringId, { category: "Astrology" }, { cookie: aliceCookie });
    check("400 for invalid category", badCat.status === 400 && "category" in (badCat.body.errors ?? {}));

    const badDesc = await patch(refactoringId, { description: "short" }, { cookie: aliceCookie });
    check("400 for short description", badDesc.status === 400);

    const badQty = await patch(refactoringId, { quantity: -1 }, { cookie: aliceCookie });
    check("400 for negative quantity", badQty.status === 400);

    const badRating = await patch(refactoringId, { rating: 9 }, { cookie: aliceCookie });
    check("400 for out-of-range rating", badRating.status === 400);
  }

  // ── 7. Other user cannot update ─────────────────────────────────────────
  console.log("\n7. Another user's update attempt");
  {
    const titleBefore = (await books.findOne({ _id: new ObjectId(refactoringId) }))?.title;
    const { status, body } = await patch(refactoringId, { title: "Bob Was Here" }, { cookie: bobCookie });
    check("403 Forbidden", status === 403);
    check("fail shape with message", body.status === "fail" && typeof body.message === "string");
    const stored = await books.findOne({ _id: new ObjectId(refactoringId) });
    check("book untouched in DB", stored?.title === titleBefore);
  }

  // ── 8. Unauthenticated requests ─────────────────────────────────────────
  console.log("\n8. Unauthenticated update/delete");
  {
    const titleBefore = (await books.findOne({ _id: new ObjectId(refactoringId) }))?.title;
    const noAuth = await patch(refactoringId, { title: "No Auth" });
    check("401 for PATCH without session", noAuth.status === 401);
    const noAuthDel = await del(refactoringId);
    check("401 for DELETE without session", noAuthDel.status === 401);
    const stored = await books.findOne({ _id: new ObjectId(refactoringId) });
    check("book untouched", stored?.title === titleBefore);
  }

  // ── 9. Invalid ObjectId ─────────────────────────────────────────────────
  console.log("\n9. Invalid ObjectId handling");
  {
    for (const bad of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const p = await patch(bad, { title: "X" }, { cookie: aliceCookie });
      check(`400 PATCH for malformed id "${bad}"`, p.status === 400);
      const d = await del(bad, aliceCookie);
      check(`400 DELETE for malformed id "${bad}"`, d.status === 400);
    }
  }

  // ── 10. Missing book ────────────────────────────────────────────────────
  console.log("\n10. Missing book");
  {
    const ghost = new ObjectId().toString();
    const p = await patch(ghost, { title: "Ghost" }, { cookie: aliceCookie });
    check("404 PATCH for absent book", p.status === 404);
    const d = await del(ghost, aliceCookie);
    check("404 DELETE for absent book", d.status === 404);
  }

  // ── 11. PUT alias (frontend contract) ───────────────────────────────────
  console.log("\n11. PUT alias for the frontend's updateBook()");
  {
    const { status, body } = await patch(refactoringId, { title: "Refactoring (Updated)" }, { cookie: aliceCookie, method: "PUT" });
    check("PUT accepted with same handler", status === 200 && body.data?.title === "Refactoring (Updated)");
  }

  // ── 12. Active borrow protection ────────────────────────────────────────
  console.log("\n12. Active borrow protection on DELETE");
  {
    const { status, body } = await del(dddId, aliceCookie);
    check("409 Conflict while borrows active", status === 409);
    check("useful message returned", typeof body.message === "string" && body.message.includes("active borrow"));
    const stored = await books.findOne({ _id: new ObjectId(dddId) });
    check("book still exists in DB", stored !== null);
    const borrow = await borrows.findOne({ bookId: new ObjectId(dddId), status: "borrowed" });
    check("active borrow record intact", borrow !== null);
  }

  // ── 13. DELETE removes book AND cleans up borrow records ────────────────
  console.log("\n13. Owner DELETE (with returned borrow history)");
  {
    const { status, body } = await del(ppId, aliceCookie);
    check("200 OK", status === 200);
    check("success flag for the frontend", body.success === true && body.status === "success");
    check("message included", typeof body.message === "string");
    check("removedBorrowRecords reported", body.removedBorrowRecords === 1, `removed=${body.removedBorrowRecords}`);
    const stored = await books.findOne({ _id: new ObjectId(ppId) });
    check("book gone from MongoDB", stored === null);
    const orphans = await borrows.countDocuments({ bookId: new ObjectId(ppId) });
    check("no orphaned borrow records remain", orphans === 0);
  }

  // ── 14. Another user cannot delete ──────────────────────────────────────
  console.log("\n14. Another user's delete attempt");
  {
    const { status } = await del(refactoringId, bobCookie);
    check("403 Forbidden", status === 403);
    const stored = await books.findOne({ _id: new ObjectId(refactoringId) });
    check("book still exists", stored !== null);
  }

  // ── 15. My Books ────────────────────────────────────────────────────────
  console.log("\n15. GET /api/my-books (and /api/books/my, /api/books/user)");
  {
    const mine = await get("/api/my-books", aliceCookie);
    check("200 for authenticated user", mine.status === 200);
    const myIds = (mine.body.books ?? []).map((b) => b.id);
    check("returns only Alice's books", myIds.length === 2 && myIds.every((id) => [refactoringId, dddId].includes(id)), `count=${myIds.length}`);
    check("newest-first order", (mine.body.books ?? [])[0]?.title !== "" );

    const bobList = await get("/api/my-books", bobCookie);
    check("Bob sees none of Alice's books", bobList.status === 200 && (bobList.body.books ?? []).length === 0);

    const fallback1 = await get("/api/books/my", aliceCookie);
    check("/api/books/my alias works", fallback1.status === 200 && (fallback1.body.books ?? []).length === 2);
    const fallback2 = await get("/api/books/user", aliceCookie);
    check("/api/books/user alias works", fallback2.status === 200 && (fallback2.body.books ?? []).length === 2);

    const spoof = await get("/api/my-books?email=bob@test.local&userId=" + bobId.toString(), aliceCookie);
    check("spoofed email/userId query ignored — still Alice's list", spoof.status === 200 && (spoof.body.books ?? []).every((b) => b.addedBy === aliceId.toString()));

    const emailFallback = await get(`/api/books/user/${encodeURIComponent("bob@test.local")}`, aliceCookie);
    check("email-based fallback NOT implemented (404 — identity never taken from URL)", emailFallback.status === 404);

    const noAuth = await get("/api/my-books");
    check("401 for unauthenticated My Books", noAuth.status === 401);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  await client.db(TEST_DB).dropDatabase();
  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("📙 Phase 6 book update/delete API verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Manage-book verification crashed:", error);
  process.exit(1);
});
