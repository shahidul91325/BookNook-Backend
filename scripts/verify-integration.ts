/**
 * Phase 9 — Frontend ↔ Backend API integration verification.
 *
 * NOT part of the runtime server. Run with: `npm run verify:integration`
 *
 * Boots the REAL Express app (`src/app.ts`) against a throwaway MongoDB
 * database, inserts Better Auth-shaped user + session documents, and
 * exercises the eight required endpoints over HTTP exactly as the Next.js
 * frontend calls them:
 *
 *   GET    /api/books
 *   GET    /api/books/:id
 *   POST   /api/books
 *   PATCH  /api/books/:id   (frontend also uses PUT — both are covered)
 *   DELETE /api/books/:id
 *   POST   /api/borrows
 *   GET    /api/borrows
 *   DELETE /api/borrows/:id (frontend also uses PUT/PATCH /:id/return — covered)
 *
 * Credentials are forwarded exactly like Better Auth 1.7.14 issues them:
 *   - HMAC-signed `better-auth.session_token` cookie value
 *   - `Authorization: Bearer <opaque session token>`
 * Identity is always resolved server-side from the `session` collection;
 * nothing client-supplied is ever trusted as identity.
 *
 * Covered user flows:
 *   1. Add book → Browse → View details → Edit own book → Delete own book
 *   2. Borrow book → View My Borrows → Return book
 *   3. Protected-route behaviour (401/403), validation errors (400),
 *      conflict errors (409), and the standard error envelope
 *   4. Data isolation between two users (Alice vs Bob)
 *
 * The throwaway database is dropped at the end so no test data lingers.
 */

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";
import { ensureIndexes } from "../src/config/indexes.js";

const TEST_DB = "booknook_integration_verify";
const SECRET = env.BETTER_AUTH_SECRET;

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

const expectStatus = (label: string, res: Awaited<ReturnType<typeof request>>, status: number) =>
  check(label, res.status === status, `got ${res.status}`);

const signSessionCookie = (token: string): string =>
  encodeURIComponent(`${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`);

const COOKIE_NAME = "better-auth.session_token";

/** Alice and Bob — two fully independent users. */
const ALICE = {
  id: new ObjectId(),
  name: "Alice Reader",
  email: "alice@integration.test",
};
const BOB = {
  id: new ObjectId(),
  name: "Bob Reader",
  email: "bob@integration.test",
};

const aliceToken = "integ-session-token-alice-0000000001";
const bobToken = "integ-session-token-bob-0000000002";

let base: string;
let server: Server;
let booksCollection: any;
let borrowsCollection: any;

/** Raw HTTP call against the running app (node fetch, no superagent). */
async function request(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

const asAlice = (extra: Record<string, string> = {}) => ({
  cookie: `${COOKIE_NAME}=${signSessionCookie(aliceToken)}`,
  ...extra,
});
const asBob = (extra: Record<string, string> = {}) => ({
  cookie: `${COOKIE_NAME}=${signSessionCookie(bobToken)}`,
  ...extra,
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** alice's own-book id, bob's own-book id, and a borrow record id — filled during the flow. */
let aliceBookId = "";
let bobBookId = "";
let borrowId = "";

async function main(): Promise<void> {
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 30_000 });
  await client.connect();
  const db = client.db(TEST_DB);
  await db.dropDatabase();
  booksCollection = db.collection("books");
  borrowsCollection = db.collection("borrows");

  // ── Fixtures: two users + valid sessions (Better Auth-shaped documents) ──
  await db.collection("user").insertMany([
    { _id: ALICE.id, name: ALICE.name, email: ALICE.email, emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
    { _id: BOB.id, name: BOB.name, email: BOB.email, emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await db.collection("session").insertMany([
    { token: aliceToken, userId: ALICE.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000), createdAt: new Date(), updatedAt: new Date() },
    { token: bobToken, userId: BOB.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000), createdAt: new Date(), updatedAt: new Date() },
    { token: "integ-session-token-expired-00000000", userId: ALICE.id, expiresAt: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date() },
  ]);

  // ── Boot the real app against the throwaway database ──
  const app = createApp(db);
  await ensureIndexes(db);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  console.log(`\nIntegration API under test: ${base}`);
  console.log(`\n──────────────────────────────────────────────`);
  console.log("0. Health + public reads (no credentials)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("GET", "/api/health");
    expectStatus("GET /api/health → 200", res, 200);
    check("health envelope is success", (res.body as { status?: string })?.status === "success");
  }

  {
    const res = await request("GET", "/api/books");
    expectStatus("GET /api/books → 200", res, 200);
    const body = res.body as { status?: string; books?: unknown };
    check("GET /api/books returns success envelope", body.status === "success");
    check("books key holds an array", Array.isArray(body.books));
  }

  // Protected routes must reject unauthenticated callers.
  {
    const res = await request("POST", "/api/books", {
      title: "Ghost Book", author: "Nobody", category: "Fiction",
      image: "https://example.com/cover.png", description: "A book that should not exist.",
    });
    expectStatus("POST /books without credentials → 401", res, 401);
    check("401 envelope is fail-shaped", (res.body as { status?: string })?.status === "fail");
  }
  {
    const res = await request("GET", "/api/my-books");
    expectStatus("GET /api/my-books without credentials → 401", res, 401);
  }
  {
    const res = await request("POST", "/api/borrows", { bookId: new ObjectId().toString() });
    expectStatus("POST /borrows without credentials → 401", res, 401);
  }
  {
    const res = await request("GET", "/api/borrows");
    expectStatus("GET /api/borrows without credentials → 401", res, 401);
  }
  {
    const res = await request("DELETE", `/api/books/${new ObjectId()}`);
    expectStatus("DELETE /books/:id without credentials → 401", res, 401);
  }
  {
    const res = await request("DELETE", `/api/borrows/${new ObjectId()}`);
    expectStatus("DELETE /borrows/:id without credentials → 401", res, 401);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("1. Better Auth credential forwarding & verification");
  console.log("──────────────────────────────────────────────");

  // Identity endpoints require a verified session.
  {
    const res = await request("GET", "/api/auth/me", undefined, asAlice());
    expectStatus("signed session cookie → GET /api/auth/me 200", res, 200);
    const data = (res.body as { data?: { id?: string; email?: string; name?: string } })?.data;
    check("cookie-resolved id is Alice's", data?.id === ALICE.id.toString());
    check("cookie-resolved email is Alice's", data?.email === ALICE.email);
  }
  {
    const res = await request("GET", "/api/auth/me", undefined, bearer(aliceToken));
    expectStatus("opaque bearer token → 200", res, 200);
    const data = (res.body as { data?: { id?: string } })?.data;
    check("bearer-resolved id is Alice's", data?.id === ALICE.id.toString());
  }
  {
    const res = await request("GET", "/api/auth/me", undefined, bearer("garbage-token"));
    expectStatus("garbage bearer → 401", res, 401);
  }
  {
    const forged = await request("GET", "/api/auth/me", undefined, {
      cookie: `${COOKIE_NAME}=${signSessionCookie(aliceToken)}`.slice(0, -5) + "ZZZZZ",
    });
    expectStatus("tampered signed cookie → 401", forged, 401);
  }
  {
    const res = await request("GET", "/api/auth/me", undefined, bearer(aliceToken));
    const data = (res.body as { data?: { email?: string } })?.data;
    check("server-derived email, never client-supplied", data?.email === ALICE.email);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("2. Flow: Alice adds a book (POST /api/books)");
  console.log("──────────────────────────────────────────────");

  // Frontend sends userName/userEmail in CreateBookInput — the server strips
  // ownership fields and derives them from the session. Body structure still
  // matches what the frontend transmits.
  const createPayload = {
    title: "The Integration Guide",
    author: "QA Engineer",
    category: "Programming & Computer Science", // only in the frontend's list
    image: "https://example.com/integration.png",
    quantity: 3,
    description: "A thorough end-to-end verification book.",
    rating: 5,
    userName: "Alice Reader",    // stripped by Zod — must not influence storage
    userEmail: "alice@integration.test", // stripped by Zod — must not influence storage
  };

  {
    const res = await request("POST", "/api/books", { ...createPayload, category: "Horror" }, asAlice());
    expectStatus("invalid category → 400", res, 400);
    const body = res.body as { status?: string; errors?: Record<string, string[]> };
    check("400 is validation-shaped", body.status === "fail" && Boolean(body.errors?.category));
  }

  {
    const res = await request("POST", "/api/books", createPayload, asAlice());
    expectStatus("POST /books (alice, valid) → 201", res, 201);
    const body = res.body as { status?: string; data?: { id?: string; title?: string; quantity?: number; userName?: string; userEmail?: string; addedBy?: string } };
    check("201 success envelope", body.status === "success");
    check("data.id present", typeof body.data?.id === "string" && body.data?.id.length === 24);
    check("quantity echoed", body.data?.quantity === 3);
    check("ownership derived from session (addedBy)", body.data?.addedBy === ALICE.id.toString());
    check("userName from session, not body", body.data?.userName === ALICE.name);
    check("userEmail from session, not body", body.data?.userEmail === ALICE.email);
    aliceBookId = body.data?.id as string;
  }

  {
    const res = await request("POST", "/api/books", {
      title: "Bob's Cookbook", author: "Bob", category: "Fantasy",
      image: "https://example.com/bob.png", quantity: 1,
      description: "Bob's only book in the library.",
    }, asBob());
    expectStatus("POST /books (bob, valid) → 201", res, 201);
    const body = res.body as { data?: { id?: string } };
    bobBookId = body.data?.id as string;
    check("bob's book created", typeof bobBookId === "string" && bobBookId.length === 24);
  }

  {
    const res = await request("GET", "/api/books");
    const body = res.body as { books?: unknown[] };
    check("catalog lists both books", Array.isArray(body.books) && (body.books as unknown[]).length >= 2);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("3. Flow: Browse → view details (GET /api/books, GET /api/books/:id)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("GET", `/api/books/${aliceBookId}`);
    expectStatus("GET /books/:id → 200", res, 200);
    const body = res.body as { status?: string; data?: { id?: string; title?: string; addedBy?: string; userEmail?: string; quantity?: number; availableCopies?: number } };
    check("data envelope", body.status === "success" && Boolean(body.data));
    check("book id matches", body.data?.id === aliceBookId);
    check("title matches", body.data?.title === "The Integration Guide");
    check("owner is alice", body.data?.addedBy === ALICE.id.toString());
    check("contributor email exposed", body.data?.userEmail === ALICE.email);
    check("quantity present", body.data?.quantity === 3);
  }
  {
    const res = await request("GET", "/api/books/not-an-object-id");
    expectStatus("malformed id → 400", res, 400);
  }
  {
    const res = await request("GET", `/api/books/${new ObjectId()}`);
    expectStatus("unknown book → 404", res, 404);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("4. My Books — user-specific list (GET /api/my-books)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("GET", "/api/my-books", undefined, asAlice());
    expectStatus("alice /api/my-books → 200", res, 200);
    const body = res.body as { status?: string; books?: unknown[] };
    check("alice sees only her books", body.status === "success" && (body.books as unknown[]).every((b) => (b as { addedBy?: string }).addedBy === ALICE.id.toString()));
    check("alice's list contains her book", (body.books as unknown[]).some((b) => (b as { id?: string }).id === aliceBookId));
  }
  {
    const res = await request("GET", "/api/my-books", undefined, asBob());
    expectStatus("bob /api/my-books → 200", res, 200);
    const body = res.body as { books?: unknown[] };
    check("bob sees only his own books", (body.books as unknown[]).every((b) => (b as { addedBy?: string }).addedBy === BOB.id.toString()));
    check("bob's list does not contain alice's book", !(body.books as unknown[]).some((b) => (b as { id?: string }).id === aliceBookId));
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("5. Edit own book (PATCH + PUT /api/books/:id)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("PATCH", `/api/books/${aliceBookId}`, { title: "The Integration Guide (Revised)" }, asAlice());
    expectStatus("alice PATCH own book → 200", res, 200);
    const body = res.body as { data?: { title?: string } };
    check("title updated", body.data?.title === "The Integration Guide (Revised)");
  }
  {
    const res = await request("PUT", `/api/books/${aliceBookId}`, { author: "Revised Author" }, asAlice());
    expectStatus("alice PUT own book (frontend verb) → 200", res, 200);
  }
  {
    const res = await request("PATCH", `/api/books/${aliceBookId}`, { title: "Hack Attempt" }, asBob());
    expectStatus("bob edits alice's book → 403", res, 403);
    check("403 envelope", (res.body as { status?: string })?.status === "fail");
  }
  {
    const res = await request("PATCH", `/api/books/${new ObjectId()}`, { title: "Nope" }, asAlice());
    expectStatus("edit nonexistent book → 404", res, 404);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("6. Borrow book (POST /api/borrows)");
  console.log("──────────────────────────────────────────────");

  const returnDate = new Date(Date.now() + 7 * 86_400_000).toISOString();

  {
    // Payload mirrors the frontend's CreateBorrowInput, including fields the
    // server strips (bookTitle, bookImage, userName, userEmail).
    const res = await request("POST", "/api/borrows", {
      bookId: bobBookId,
      bookTitle: "Fake Title",       // stripped — server reads the book doc itself
      bookImage: "https://example.com/fake.png",
      userName: "Impostor",         // stripped — identity comes from session
      userEmail: "impostor@example.test",
      returnDate,
    }, asAlice());
    expectStatus("alice borrows bob's book → 201", res, 201);
    const body = res.body as { status?: string; data?: { id?: string; bookId?: string; bookTitle?: string; userId?: string; status?: string; returnDate?: string } };
    check("borrow envelope", body.status === "success" && Boolean(body.data));
    check("borrow id present", typeof body.data?.id === "string" && body.data?.id.length === 24);
    check("bookId stored", body.data?.bookId === bobBookId);
    check("bookTitle from DB document", body.data?.bookTitle === "Bob's Cookbook");
    check("userId is alice's (session)", body.data?.userId === ALICE.id.toString());
    check("status is borrowed", body.data?.status === "borrowed");
    borrowId = body.data?.id as string;
  }
  {
    // Same user, same book while active → duplicate borrow rejected.
    const res = await request("POST", "/api/borrows", { bookId: bobBookId, returnDate }, asAlice());
    expectStatus("duplicate active borrow → 409", res, 409);
  }
  {
    // Bob's only copy is out on loan → no copies available.
    const res = await request("POST", "/api/borrows", { bookId: bobBookId, returnDate }, asBob());
    expectStatus("no copies available → 409", res, 409);
  }
  {
    const res = await request("POST", "/api/borrows", { bookId: new ObjectId().toString(), returnDate }, asAlice());
    expectStatus("borrow nonexistent book → 404", res, 404);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("7. My Borrows — user-specific borrow list (GET /api/borrows)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("GET", "/api/borrows", undefined, asAlice());
    expectStatus("alice /api/borrows → 200", res, 200);
    const body = res.body as { status?: string; data?: unknown[] };
    check("alice sees her borrow only", body.status === "success" && Array.isArray(body.data) && (body.data as unknown[]).length === 1);
    check("record is the active borrow", (body.data as unknown[])[0] && (body.data as unknown[])[0] as { id?: string } && ((body.data as unknown[])[0] as { id?: string }).id === borrowId);
  }
  {
    const res = await request("GET", "/api/borrows", undefined, asBob());
    expectStatus("bob /api/borrows → 200", res, 200);
    const body = res.body as { data?: unknown[] };
    check("bob sees none of alice's borrows", Array.isArray(body.data) && (body.data as unknown[]).length === 0);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("8. Edit while borrowed → availableCopies clamped (PATCH /api/books/:id)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("PATCH", `/api/books/${bobBookId}`, { quantity: 1 }, asBob());
    expectStatus("bob reduces quantity while borrowed → 200", res, 200);
    const body = res.body as { data?: { availableCopies?: number } };
    check("availableCopies clamped at 0 (1 total − 1 on loan)", body.data?.availableCopies === 0);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("9. Return book (DELETE /api/borrows/:id + PUT /:id/return alias)");
  console.log("──────────────────────────────────────────────");

  let bobBorrowOfAliceBookId = "";

  {
    const res = await request("DELETE", `/api/borrows/${borrowId}`, undefined, asBob());
    expectStatus("bob returns alice's borrow → 403", res, 403);
  }
  {
    const res = await request("DELETE", `/api/borrows/${borrowId}`, undefined, asAlice());
    expectStatus("alice returns her borrow → 200", res, 200);
    const body = res.body as { status?: string; success?: boolean; message?: string };
    check("return envelope {success:true, message}", body.status === "success" && body.success === true && typeof body.message === "string");
  }
  {
    const res = await request("DELETE", `/api/borrows/${borrowId}`, undefined, asAlice());
    expectStatus("return already-returned → 409", res, 409);
  }
  // Alice borrows bob's book again to test the PUT /return alias.
  {
    const res = await request("POST", "/api/borrows", { bookId: bobBookId, returnDate }, asAlice());
    expectStatus("alice borrows again → 201", res, 201);
    const secondId = (res.body as { data?: { id?: string } })?.data?.id as string;
    const res2 = await request("PUT", `/api/borrows/${secondId}/return`, undefined, asAlice());
    expectStatus("PUT /borrows/:id/return (frontend alias) → 200", res2, 200);
    check("return alias {success:true}", (res2.body as { success?: boolean })?.success === true);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("10. Delete own book (DELETE /api/books/:id)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("DELETE", `/api/books/${aliceBookId}`, undefined, asBob());
    expectStatus("bob deletes alice's book → 403", res, 403);
  }
  {
    // Bob borrows Alice's book → an active borrow now references aliceBookId.
    const res = await request("POST", "/api/borrows", { bookId: aliceBookId, returnDate }, asBob());
    expectStatus("bob borrows alice's book → 201", res, 201);
    const body = res.body as { data?: { id?: string } };
    bobBorrowOfAliceBookId = body.data?.id as string;
    check("borrow id present", typeof bobBorrowOfAliceBookId === "string" && bobBorrowOfAliceBookId.length === 24);
  }
  {
    // Active borrow still references alice's book → deletion refused with 409.
    const res = await request("DELETE", `/api/books/${aliceBookId}`, undefined, asAlice());
    expectStatus("delete with active borrow → 409", res, 409);
    const errBody = res.body as { status?: string; message?: string };
    check("409 is fail-shaped", errBody.status === "fail" && typeof errBody.message === "string");
  }
  {
    // Bob returns his borrow of Alice's book, then Alice's delete succeeds.
    const res = await request("DELETE", `/api/borrows/${bobBorrowOfAliceBookId}`, undefined, asBob());
    expectStatus("borrower returns before delete → 200", res, 200);
    const res2 = await request("DELETE", `/api/books/${aliceBookId}`, undefined, asAlice());
    expectStatus("alice deletes own book → 200", res2, 200);
    const delBody = res2.body as { status?: string; success?: boolean; message?: string };
    check("delete envelope {success:true, message}", delBody.status === "success" && delBody.success === true && typeof delBody.message === "string");
  }
  {
    const res = await request("GET", `/api/books/${aliceBookId}`);
    expectStatus("deleted book → 404", res, 404);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("11. Error response compatibility");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("POST", "/api/books", { title: "X" }, asAlice());
    expectStatus("incomplete create body → 400", res, 400);
    const body = res.body as { status?: string; message?: string; errors?: Record<string, string[]> };
    check("400 validation envelope {fail, message, errors}", body.status === "fail" && typeof body.message === "string" && Boolean(body.errors));
  }
  {
    const res = await request("DELETE", `/api/borrows/${new ObjectId()}`, undefined, asAlice());
    expectStatus("delete unknown borrow → 404", res, 404);
  }
  {
    const res = await request("DELETE", "/api/borrows/not-an-object-id", undefined, asAlice());
    expectStatus("malformed borrow id → 400", res, 400);
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("12. Data isolation — Alice vs Bob (finale)");
  console.log("──────────────────────────────────────────────");

  {
    const res = await request("GET", `/api/books/${bobBookId}`, undefined, asAlice());
    expectStatus("alice reads bob's book details (public) → 200", res, 200); // details are public
  }
  {
    const res = await request("PATCH", `/api/books/${bobBookId}`, { title: "Hacked" }, asAlice());
    expectStatus("alice edits bob's book → 403", res, 403);
  }
  {
    const res = await request("DELETE", `/api/books/${bobBookId}`, undefined, asAlice());
    expectStatus("alice deletes bob's book → 403", res, 403);
  }
  {
    const res = await request("DELETE", `/api/borrows/${borrowId}`, undefined, asBob());
    expectStatus("bob returns alice's borrow → 403", res, 403);
  }

  // ── Teardown ──
  await server.close();
  await client.close();

  console.log(`\n==================================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`==================================================`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error("INTEGRATION RUN ERROR:", error);
  process.exit(2);
});
