/**
 * Phase 7 verification script — NOT part of the runtime server.
 * Run with: npm run verify:borrows
 *
 * Connects to a temporary throwaway database (booknook_borrow_verification),
 * ensures the production indexes (including the partial unique active-borrow
 * index), seeds verified users + signed session cookies + books, then
 * exercises POST/GET/DELETE /api/borrows over HTTP against the real Express
 * app. The database is dropped afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1. Successful borrow                        → 201, server-built record
 *   2. Server ignores spoofed body identity     → session + DB values win
 *   3. Server-generated borrow/return dates     → 14-day default
 *   4. Client returnDate honored within bounds  → +7 days stored
 *   5. Out-of-range / past / invalid dates      → 400
 *   6. Unavailable book (0 copies)              → 409, nothing stored
 *   7. Duplicate active borrow                  → 409
 *   8. Different users borrow the same book     → both succeed
 *   9. User-specific borrow list                → own records only, sorted
 *  10. Spoofed email/userId query ignored       → session wins
 *  11. Return: marks returned + restores copy   → exactly once
 *  12. Duplicate return                         → 409, copy NOT restored again
 *  13. Unauthorized return (wrong user)         → 403
 *  14. Invalid / missing borrow ids             → 400 / 404
 *  15. PUT /api/borrows/:id/return alias        → 200 (frontend path)
 *  16. Concurrent final-copy borrows            → exactly one succeeds
 *  17. Concurrent duplicate borrows (same user) → exactly one succeeds
 *  18. Concurrent duplicate returns             → exactly one restores
 *  19. Return clamped when totalCopies shrunk   → never exceeds total
 *  20. Unauthenticated requests                 → 401
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";
import { ensureIndexes } from "../src/config/indexes.js";

const TEST_DB = "booknook_borrow_verification";

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

interface ApiBorrow {
  id: string;
  bookId: string;
  bookTitle: string;
  bookImage: string;
  userId: string;
  userName: string;
  userEmail: string;
  borrowDate: string;
  returnDate: string;
  returnedAt: string | null;
  status: string;
}

interface Envelope {
  status: string;
  message?: string;
  success?: boolean;
  errors?: Record<string, string[]>;
  results?: number;
  total?: number;
  data?: ApiBorrow | ApiBorrow[];
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
  // Production boot calls this — it creates the partial unique index that
  // makes duplicate active borrows impossible at the DB level.
  await ensureIndexes(db);

  // ── Fixtures: verified users with valid signed sessions ─────────────────
  const now = new Date();
  const names: Record<string, ObjectId> = {
    alice: new ObjectId(),
    bob: new ObjectId(),
    carol: new ObjectId(),
    dave: new ObjectId(),
    erin: new ObjectId(),
  };
  await users.insertMany(
    Object.entries(names).map(([name, id]) => ({
      _id: id,
      name: name[0].toUpperCase() + name.slice(1) + " User",
      email: `${name}@test.local`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    }))
  );
  const tokens: Record<string, string> = {};
  await sessions.insertMany(
    Object.entries(names).map(([name, id]) => {
      const token = `borrow-phase-session-${name.padEnd(12, "0")}`;
      tokens[name] = token;
      return {
        token,
        userId: id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      };
    })
  );
  const cookieName = "better-auth.session_token";
  const cookieFor = (name: string): string =>
    `${cookieName}=${signSessionCookie(tokens[name], env.BETTER_AUTH_SECRET)}`;

  // ── Fixtures: books owned by Alice ──────────────────────────────────────
  const mkBook = (over: Record<string, unknown>) => ({
    category: "Fiction",
    image: "https://example.com/db-cover.jpg",
    description: "A perfectly valid book description for testing purposes.",
    addedBy: names.alice.toString(),
    addedByName: "Alice User",
    addedByEmail: "alice@test.local",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  const ins = await books.insertMany([
    mkBook({ title: "Regular Book", totalCopies: 3, availableCopies: 3 }),
    mkBook({ title: "Full Book", totalCopies: 2, availableCopies: 0 }),
    mkBook({ title: "Last Copy Book", totalCopies: 1, availableCopies: 1 }),
    mkBook({ title: "Shrinkable Book", totalCopies: 1, availableCopies: 1 }),
    mkBook({ title: "Sort Book", totalCopies: 1, availableCopies: 1 }),
  ]);
  const [regularId, fullId, lastCopyId, shrinkableId, sortbookId] = [0, 1, 2, 3, 4].map(
    (i) => ins.insertedIds[i].toString()
  );

  const app = createApp(db);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const postBorrow = async (
    body: unknown,
    user?: string
  ): Promise<{ status: number; body: Envelope }> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers.cookie = cookieFor(user);
    const res = await fetch(`${base}/api/borrows`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Envelope };
  };

  const getBorrows = async (
    path = "/api/borrows",
    user?: string
  ): Promise<{ status: number; body: Envelope }> => {
    const headers: Record<string, string> = {};
    if (user) headers.cookie = cookieFor(user);
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as Envelope };
  };

  const returnBorrow = async (
    id: string,
    user?: string,
    method: "DELETE" | "PUT" | "PATCH" = "DELETE"
  ): Promise<{ status: number; body: Envelope }> => {
    const headers: Record<string, string> = {};
    if (user) headers.cookie = cookieFor(user);
    // DELETE uses /api/borrows/:id; the PUT/PATCH aliases use .../return.
    const path = method === "DELETE" ? `/api/borrows/${id}` : `/api/borrows/${id}/return`;
    const res = await fetch(`${base}${path}`, { method, headers });
    return { status: res.status, body: (await res.json()) as Envelope };
  };

  const bookAvail = async (id: string): Promise<number | undefined> =>
    (await books.findOne({ _id: new ObjectId(id) }))?.availableCopies;

  // ── 1. Successful borrow ────────────────────────────────────────────────
  console.log("\n1. Successful borrow");
  let aliceBorrowId = "";
  {
    const { status, body } = await postBorrow(
      {
        bookId: regularId,
        bookTitle: "SPOOFED TITLE",
        bookImage: "https://evil.example/fake.jpg",
        userName: "Spoofy McSpoof",
        userEmail: "spoof@evil.local",
      },
      "alice"
    );
    check("201 Created", status === 201);
    check("status success + message", body.status === "success" && typeof body.message === "string");
    const data = body.data as ApiBorrow;
    aliceBorrowId = data.id;
    check("id is 24-char hex", /^[0-9a-f]{24}$/.test(data.id));
    check("bookId points at the real book", data.bookId === regularId);
    check("bookTitle taken from DB, not client", data.bookTitle === "Regular Book", data.bookTitle);
    check("bookImage taken from DB, not client", data.bookImage === "https://example.com/db-cover.jpg");
    check("userId from verified session", data.userId === names.alice.toString());
    check("userName from session, not spoofed", data.userName === "Alice User");
    check("userEmail from session, not spoofed", data.userEmail === "alice@test.local");
    check("status is borrowed", data.status === "borrowed");
    check("borrowDate is fresh", Math.abs(Date.parse(data.borrowDate) - Date.now()) < 5000);
    const due = Date.parse(data.returnDate);
    const defaultDue = Date.now() + 14 * 86_400_000;
    check("returnDate = 14-day default (server-generated)", Math.abs(due - defaultDue) < 300_000, `${Math.round((due - Date.now()) / 86_400_000)} days`);
    check("returnedAt is null while active", data.returnedAt === null);
    check("availableCopies decremented 3 → 2", (await bookAvail(regularId)) === 2);
  }

  // ── 2. Duplicate active borrow ──────────────────────────────────────────
  console.log("\n2. Duplicate active borrow blocked");
  {
    const { status, body } = await postBorrow({ bookId: regularId }, "alice");
    check("409 for duplicate active borrow", status === 409);
    check("useful message", typeof body.message === "string" && body.message.includes("already"));
    check("no extra record stored", (await borrows.countDocuments({ userId: names.alice.toString(), status: "borrowed" })) === 1);
    check("availableCopies unchanged", (await bookAvail(regularId)) === 2);
  }

  // ── 3. Client-requested return date (bounded by the server) ─────────────
  console.log("\n3. Client returnDate honored within server bounds");
  let bobBorrowId = "";
  {
    const requested = new Date(Date.now() + 7 * 86_400_000).toISOString().split("T")[0];
    const { status, body } = await postBorrow({ bookId: regularId, returnDate: requested }, "bob");
    check("201 with +7-day request", status === 201);
    const data = body.data as ApiBorrow;
    bobBorrowId = data.id;
    check("requested deadline stored", Math.abs(Date.parse(data.returnDate) - Date.parse(requested)) < 60_000);
    check("availableCopies 2 → 1", (await bookAvail(regularId)) === 1);

    const tooFar = new Date(Date.now() + 45 * 86_400_000).toISOString().split("T")[0];
    const far = await postBorrow({ bookId: lastCopyId, returnDate: tooFar }, "bob");
    check("400 for deadline beyond 30-day cap", far.status === 400);

    const past = await postBorrow({ bookId: lastCopyId, returnDate: "2020-01-01" }, "bob");
    check("400 for past deadline", past.status === 400);

    const invalid = await postBorrow({ bookId: lastCopyId, returnDate: "not-a-date" }, "bob");
    check("400 for unparseable deadline", invalid.status === 400);

    check("rejected requests reserved nothing", (await bookAvail(lastCopyId)) === 1);
  }

  // ── 4. Unavailable book ─────────────────────────────────────────────────
  console.log("\n4. Unavailable book (0 available copies)");
  {
    const { status, body } = await postBorrow({ bookId: fullId }, "carol");
    check("409 Conflict", status === 409);
    check("message says unavailable", typeof body.message === "string" && body.message.includes("available"));
    check("no record stored", (await borrows.countDocuments({ bookId: new ObjectId(fullId) })) === 0);
  }

  // ── 5. Invalid / missing book id ────────────────────────────────────────
  console.log("\n5. Invalid and missing book ids");
  {
    check("400 for malformed bookId", (await postBorrow({ bookId: "not-an-id" }, "carol")).status === 400);
    check("400 for missing bookId", (await postBorrow({}, "carol")).status === 400);
    check("404 for absent book", (await postBorrow({ bookId: new ObjectId().toString() }, "carol")).status === 404);
    check("401 unauthenticated", (await postBorrow({ bookId: regularId })).status === 401);
  }

  // ── 6. User-specific borrow list ────────────────────────────────────────
  console.log("\n6. GET /api/borrows — only the caller's records");
  {
    const alice = await getBorrows("/api/borrows", "alice");
    check("200 for authenticated user", alice.status === 200);
    const aliceRecords = (alice.body.data as ApiBorrow[]) ?? [];
    check("Alice sees exactly her 1 record", aliceRecords.length === 1 && aliceRecords[0]?.id === aliceBorrowId);
    check("envelope counts present", alice.body.results === 1 && alice.body.total === 1);

    const bob = await getBorrows("/api/borrows", "bob");
    const bobRecords = (bob.body.data as ApiBorrow[]) ?? [];
    check("Bob sees only his record", bobRecords.length === 1 && bobRecords[0]?.userId === names.bob.toString());

    const carol = await getBorrows("/api/borrows", "carol");
    check("Carol sees an empty list", carol.status === 200 && ((carol.body.data as ApiBorrow[]) ?? []).length === 0);

    const spoof = await getBorrows(`/api/borrows?email=bob@test.local&userId=${names.bob.toString()}`, "alice");
    const spoofRecords = (spoof.body.data as ApiBorrow[]) ?? [];
    check("spoofed email/userId query ignored", spoofRecords.every((r) => r.userId === names.alice.toString()));

    check("401 unauthenticated", (await getBorrows()).status === 401);
    for (const alias of ["/api/my-borrows", "/api/borrows/my", "/api/borrows/user"]) {
      const res = await getBorrows(alias, "alice");
      check(`${alias} alias works`, res.status === 200 && ((res.body.data as ApiBorrow[]) ?? []).length === 1);
    }
    const emailPath = await getBorrows(`/api/borrows/user/${encodeURIComponent("bob@test.local")}`, "alice");
    check("email-based path NOT implemented (404)", emailPath.status === 404);
  }

  // ── 7. Return marks returned + restores the copy ────────────────────────
  console.log("\n7. DELETE /api/borrows/:id — return a book");
  {
    const { status, body } = await returnBorrow(aliceBorrowId, "alice");
    check("200 OK", status === 200);
    check("success flag for the frontend", body.success === true && body.status === "success");
    check("availableCopies restored 1 → 2", (await bookAvail(regularId)) === 2);
    const stored = await borrows.findOne({ _id: new ObjectId(aliceBorrowId) });
    check("status flipped to returned", stored?.status === "returned");
    check("returnedAt set by server", stored?.returnedAt instanceof Date && Math.abs(Date.now() - stored.returnedAt.getTime()) < 5000);
  }

  // ── 8. Duplicate return ─────────────────────────────────────────────────
  console.log("\n8. Duplicate return blocked");
  {
    const { status } = await returnBorrow(aliceBorrowId, "alice");
    check("409 for already-returned record", status === 409);
    check("copy NOT restored again", (await bookAvail(regularId)) === 2);
  }

  // ── 9. Unauthorized return ──────────────────────────────────────────────
  console.log("\n9. Another user cannot return your record");
  {
    const { status } = await returnBorrow(bobBorrowId, "carol");
    check("403 Forbidden", status === 403);
    check("record still active", (await borrows.findOne({ _id: new ObjectId(bobBorrowId) }))?.status === "borrowed");
  }

  // ── 10. Invalid / missing borrow ids ────────────────────────────────────
  console.log("\n10. Invalid and missing borrow ids");
  {
    check("400 for malformed id", (await returnBorrow("junk", "alice")).status === 400);
    check("404 for absent record", (await returnBorrow(new ObjectId().toString(), "alice")).status === 404);
    check("401 unauthenticated", (await returnBorrow(aliceBorrowId)).status === 401);
  }

  // ── 11. PUT /return alias (frontend's preferred path) ───────────────────
  console.log("\n11. PUT /api/borrows/:id/return alias");
  {
    const { status } = await returnBorrow(bobBorrowId, "bob", "PUT");
    check("PUT alias accepted", status === 200);
    check("availableCopies restored 2 → 3", (await bookAvail(regularId)) === 3);
  }

  // ── 12. Concurrent final-copy borrows ───────────────────────────────────
  console.log("\n12. Concurrent borrows of the LAST copy");
  {
    const attempts = await Promise.all(
      ["carol", "dave", "erin"].map((u) => postBorrow({ bookId: lastCopyId }, u))
    );
    const wins = attempts.filter((a) => a.status === 201);
    const losses = attempts.filter((a) => a.status === 409);
    check("exactly one request wins the last copy", wins.length === 1, `wins=${wins.length}`);
    check("losers get 409", losses.length === 2);
    check("availableCopies is 0", (await bookAvail(lastCopyId)) === 0);
    check("exactly one active record", (await borrows.countDocuments({ bookId: new ObjectId(lastCopyId), status: "borrowed" })) === 1);
    const extra = await postBorrow({ bookId: lastCopyId }, "alice");
    check("subsequent borrow also 409", extra.status === 409);
  }

  // ── 13. Concurrent duplicate borrows (same user) ────────────────────────
  console.log("\n13. Concurrent duplicate borrows by the SAME user");
  {
    const availBefore = await bookAvail(regularId);
    const attempts = await Promise.all([
      postBorrow({ bookId: regularId }, "carol"),
      postBorrow({ bookId: regularId }, "carol"),
    ]);
    const wins = attempts.filter((a) => a.status === 201);
    check("at most one succeeds", wins.length === 1, `wins=${wins.length}`);
    check("the other gets 409", attempts.some((a) => a.status === 409));
    check("exactly one active record for Carol", (await borrows.countDocuments({ userId: names.carol.toString(), bookId: new ObjectId(regularId), status: "borrowed" })) === 1);
    check("availableCopies decremented exactly once", (await bookAvail(regularId)) === (availBefore ?? 0) - 1);
  }

  // ── 14. Concurrent duplicate returns ────────────────────────────────────
  console.log("\n14. Concurrent returns of the SAME record");
  {
    // Carol's active borrow from the previous race.
    const record = await borrows.findOne({ userId: names.carol.toString(), bookId: new ObjectId(regularId), status: "borrowed" });
    const recordId = record!._id.toString();
    const availBefore = await bookAvail(regularId);
    const attempts = await Promise.all([
      returnBorrow(recordId, "carol"),
      returnBorrow(recordId, "carol"),
    ]);
    const wins = attempts.filter((a) => a.status === 200);
    check("exactly one return succeeds", wins.length === 1, `wins=${wins.length}`);
    check("the other gets 409", attempts.some((a) => a.status === 409));
    check("copy restored EXACTLY once", (await bookAvail(regularId)) === (availBefore ?? 0) + 1);
  }

  // ── 15. Return clamped when totalCopies shrank mid-borrow ───────────────
  console.log("\n15. Return stays consistent after the owner shrinks quantity");
  {
    const borrowed = await postBorrow({ bookId: shrinkableId }, "bob");
    check("201 borrow of Shrinkable Book", borrowed.status === 201);
    check("availableCopies 1 → 0", (await bookAvail(shrinkableId)) === 0);

    // Owner (alice) sets quantity to 0 while the book is out.
    const patchRes = await fetch(`${base}/api/books/${shrinkableId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookieFor("alice") },
      body: JSON.stringify({ quantity: 0 }),
    });
    check("owner sets quantity 0 while borrowed", patchRes.status === 200);

    const ret = await returnBorrow((borrowed.body.data as ApiBorrow).id, "bob");
    check("return still succeeds", ret.status === 200);
    const doc = await books.findOne({ _id: new ObjectId(shrinkableId) });
    check("availableCopies clamped at totalCopies (0)", doc?.availableCopies === 0, `availableCopies=${doc?.availableCopies}`);
  }

  // ── 16. Sorted, complete list for the owner ─────────────────────────────
  console.log("\n16. Borrow list is sorted newest-first and complete");
  {
    const borrow = await postBorrow({ bookId: sortbookId }, "alice");
    check("201 borrow of Sort Book", borrow.status === 201);
    const list = await getBorrows("/api/borrows", "alice");
    const records = (list.body.data as ApiBorrow[]) ?? [];
    check("Alice now has 2 records (history kept)", records.length === 2);
    check("newest borrow first", records[0]?.bookTitle === "Sort Book" && records[1]?.bookTitle === "Regular Book", records.map((r) => r.bookTitle).join(" | "));
    check("history includes returned records with status", records[1]?.status === "returned");
    check("active record has null returnedAt", records[0]?.returnedAt === null && records[0]?.status === "borrowed");
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
  console.log("📘 Phase 7 borrow/return system verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Borrow verification crashed:", error);
  process.exit(1);
});
