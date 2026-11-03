/**
 * Phase 8 verification script — NOT part of the runtime server.
 * Run with: npm run verify:security
 *
 * Connects to a temporary throwaway database (booknook_security_verification),
 * seeds verified users + signed session cookies + books/borrows, then audits
 * the hardened Express app over HTTP (plus direct unit calls into the
 * centralized error handler / log scrubber). The database is dropped
 * afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1.  Error-response envelope consistency (fail/error + message, no stack)
 *   2.  Invalid payloads                       → 400 + per-field errors
 *   3.  Malformed JSON & oversized bodies      → 400 / 413, clean envelopes
 *   4.  Unauthorized requests (every protected endpoint) → 401
 *   5.  Forbidden requests (foreign resources) → 403, resource untouched
 *   6.  Invalid MongoDB ObjectIds              → 400, no query executed
 *   7.  CORS: allowlist, credentials, preflight, foreign origin blocked
 *   8.  Centralized error handler unit tests (500 never leaks internals)
 *   9.  Safe logging scrubber (credentials/tokens redacted)
 *   10. Rate limiting: 429 + Retry-After on write and global budgets
 *   11. Ownership spoofing attempts            → stripped, session wins
 *   12. All API endpoints happy path (contract intact)
 *   13. Final sweep: no response ever contains stack frames, driver
 *       internals, connection strings, or secret values
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { env } from "../src/config/env.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ApiError, OperationError } from "../src/utils/errors.js";
import { sanitizeLogText } from "../src/utils/logger.js";
import { createBookSchema } from "../src/validations/book.validation.js";

const TEST_DB = "booknook_security_verification";

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
  status?: string;
  message?: string;
  success?: boolean;
  errors?: Record<string, string[]>;
  results?: number;
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  environment?: string;
  timestamp?: string;
  removedBorrowRecords?: number;
  books?: ApiBook[];
  data?: ApiBook | ApiBorrow | ApiBook[] | ApiBorrow[] | Record<string, unknown>;
}

type HttpResult = { status: number; body: Envelope; headers: Headers };

/** Every error body seen over HTTP — swept for leaks at the very end. */
const errorBodies: string[] = [];

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);
  const books = db.collection("books");
  const borrows = db.collection("borrows");
  const users = db.collection("user");
  await books.deleteMany({});
  await borrows.deleteMany({});
  await users.deleteMany({});

  // ── Fixtures: users authenticated by Better Auth signed JWTs ────────────
  const now = new Date();
  const aliceId = new ObjectId();
  const bobId = new ObjectId();
  await users.insertMany([
    { _id: aliceId, name: "Alice Owner", email: "alice@test.local", emailVerified: true, image: null, createdAt: now, updatedAt: now },
    { _id: bobId, name: "Bob Other", email: "bob@test.local", emailVerified: true, image: null, createdAt: now, updatedAt: now },
  ]);
  const auth = createAuth(db);
  const makeJwt = async (userId: ObjectId, exp: number): Promise<string> => {
    const result = await auth.api.signJWT({
      body: {
        payload: { sub: userId.toString(), iat: Math.floor(Date.now() / 1000), exp },
      },
    });
    return result.token;
  };
  const aliceToken = await makeJwt(aliceId, Math.floor(Date.now() / 1000) + 3600);
  const bobToken = await makeJwt(bobId, Math.floor(Date.now() / 1000) + 3600);

  // ── Fixtures: books + one active borrow ─────────────────────────────────
  const baseTime = Date.now();
  const mkBook = (over: Record<string, unknown>) => ({
    category: "Fiction",
    image: "https://example.com/cover.jpg",
    description: "A perfectly valid book description for testing purposes.",
    addedBy: aliceId.toString(),
    addedByName: "Alice Owner",
    addedByEmail: "alice@test.local",
    totalCopies: 3,
    availableCopies: 3,
    createdAt: new Date(baseTime - 60_000),
    updatedAt: new Date(baseTime - 60_000),
    ...over,
  });
  const ins = await books.insertMany([
    mkBook({ title: "Secure Book", totalCopies: 3, availableCopies: 2 }),
    mkBook({ title: "Delete Me Book", totalCopies: 1, availableCopies: 1 }),
  ]);
  const secureId = ins.insertedIds[0].toString();
  const deleteMeId = ins.insertedIds[1].toString();
  await borrows.insertOne({
    bookId: ins.insertedIds[0],
    bookTitle: "Secure Book",
    bookImage: "https://example.com/cover.jpg",
    userId: aliceId.toString(),
    userName: "Alice Owner",
    userEmail: "alice@test.local",
    borrowDate: new Date(),
    returnDate: new Date(Date.now() + 14 * 86_400_000),
    returnedAt: null,
    status: "borrowed",
  });

  // ── Boot the real app (generous budgets so the audit itself never trips
  //    the limiter; the limiter is exercised on dedicated apps below) ──────
  const app = createApp(db, {
    rateLimit: { global: { max: 10_000 }, write: { max: 10_000 } },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  process.env.JWT_JWKS_URL = `${base}/api/auth/jwks`;

  const request = async (
    path: string,
    init: RequestInit = {}
  ): Promise<HttpResult> => {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let body: Envelope = {};
    try {
      body = JSON.parse(text) as Envelope;
    } catch {
      body = {};
    }
    if (res.status >= 400) errorBodies.push(text);
    return { status: res.status, body, headers: res.headers };
  };

  const get = (path: string, token?: string, origin?: string): Promise<HttpResult> =>
    request(path, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
      },
    });

  const send = (
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body: unknown,
    token?: string,
    rawBody?: string
  ): Promise<HttpResult> =>
    request(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: rawBody ?? JSON.stringify(body),
    });

  /** Asserts the standard failure envelope on any 4xx/5xx response. */
  const checkErrorEnvelope = (label: string, result: HttpResult): void => {
    const expectedStatus = result.status >= 500 ? "error" : "fail";
    check(`${label}: status ${result.status} uses "${expectedStatus}"`, result.body.status === expectedStatus, `got ${result.body.status}`);
    check(`${label}: has a human-readable message`, typeof result.body.message === "string" && (result.body.message as string).length > 0);
    const raw = JSON.stringify(result.body);
    check(`${label}: no stack trace in response`, !("stack" in result.body) && !/\.ts:\d+:\d+/.test(raw));
    check(`${label}: no driver/DB internals`, !/E11000|MongoServerError|collection:|index:/.test(raw));
  };

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n1. Error-response envelope consistency");
  {
    const cases: Array<[string, HttpResult]> = [
      ["400 invalid payload", await send("/api/books", "POST", {}, aliceToken)],
      ["401 unauthenticated", await get("/api/my-books")],
      ["403 foreign resource", await send(`/api/books/${secureId}`, "PATCH", { title: "Hacked" }, bobToken)],
      ["404 unknown route", await get("/api/does-not-exist")],
      ["400 invalid id", await get("/api/books/not-an-id")],
    ];
    for (const [label, result] of cases) checkErrorEnvelope(label, result);

    // Success envelopes always carry status: "success".
    const ok = await get("/api/health");
    check("200 success envelope on health", ok.status === 200 && ok.body.status === "success");
    check("health exposes environment, not internals", ok.body.environment === env.NODE_ENV && !("stack" in ok.body));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n2. Invalid payloads → 400 with per-field errors");
  {
    const emptyCreate = await send("/api/books", "POST", {}, aliceToken);
    check("400 for empty book body", emptyCreate.status === 400);
    const createKeys = Object.keys(emptyCreate.body.errors ?? {});
    check("per-field errors for title/author/category/image/description",
      ["title", "author", "category", "image", "description"].every((f) => createKeys.includes(f)),
      createKeys.join(","));
    checkErrorEnvelope("empty create", emptyCreate);

    const badCategory = await send(
      "/api/books",
      "POST",
      { title: "Valid Title", author: "Valid Author", category: "Astrology", image: "https://x.test/i.jpg", description: "A valid description, long enough." },
      aliceToken
    );
    check("400 for disallowed category", badCategory.status === 400 && "category" in (badCategory.body.errors ?? {}));

    const badImage = await send(
      "/api/books",
      "POST",
      { title: "Valid Title", author: "Valid Author", category: "Fiction", image: "javascript:alert(1)", description: "A valid description, long enough." },
      aliceToken
    );
    check("400 for javascript: image", badImage.status === 400 && "image" in (badImage.body.errors ?? {}));

    const emptyUpdate = await send(`/api/books/${secureId}`, "PATCH", {}, aliceToken);
    check("400 for empty update body", emptyUpdate.status === 400);
    checkErrorEnvelope("empty update", emptyUpdate);

    const emptyBorrow = await send("/api/borrows", "POST", {}, aliceToken);
    check("400 for empty borrow body", emptyBorrow.status === 400 && "bookId" in (emptyBorrow.body.errors ?? {}));
    const junkBorrow = await send("/api/borrows", "POST", { bookId: "junk" }, aliceToken);
    check("400 for malformed bookId in body", junkBorrow.status === 400 && "bookId" in (junkBorrow.body.errors ?? {}));
    const pastDate = await send("/api/borrows", "POST", { bookId: secureId, returnDate: "2020-01-01" }, aliceToken);
    check("400 for past returnDate", pastDate.status === 400 && "returnDate" in (pastDate.body.errors ?? {}));
    checkErrorEnvelope("borrow payload", pastDate);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n3. Malformed JSON and oversized request bodies");
  {
    const malformed = await send("/api/books", "POST", undefined, aliceToken, '{"title": "unterminated');
    check("400 for malformed JSON", malformed.status === 400);
    checkErrorEnvelope("malformed JSON", malformed);
    check("malformed JSON message does not echo the payload",
      typeof malformed.body.message === "string" && !(malformed.body.message as string).includes("unterminated"));

    const huge = await send(
      "/api/books",
      "POST",
      undefined,
      aliceToken,
      JSON.stringify({ description: "x".repeat(700_000) })
    );
    check("413 for body over the 512kb limit", huge.status === 413, `got ${huge.status}`);
    checkErrorEnvelope("oversized body", huge);
    check("oversized body message is friendly",
      typeof huge.body.message === "string" && (huge.body.message as string).includes("too large"));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n4. Unauthorized requests → 401 on every protected endpoint");
  {
    const protectedCalls: Array<[string, Promise<HttpResult>]> = [
      ["POST /api/books", send("/api/books", "POST", { title: "X" })],
      ["GET /api/my-books", get("/api/my-books")],
      ["GET /api/books/my", get("/api/books/my")],
      ["GET /api/books/user", get("/api/books/user")],
      ["PATCH /api/books/:id", send(`/api/books/${secureId}`, "PATCH", { title: "X" })],
      ["PUT /api/books/:id", send(`/api/books/${secureId}`, "PUT", { title: "X" })],
      ["DELETE /api/books/:id", send(`/api/books/${secureId}`, "DELETE", undefined)],
      ["POST /api/borrows", send("/api/borrows", "POST", { bookId: secureId })],
      ["GET /api/borrows", get("/api/borrows")],
      ["GET /api/my-borrows", get("/api/my-borrows")],
      ["GET /api/borrows/my", get("/api/borrows/my")],
      ["GET /api/borrows/user", get("/api/borrows/user")],
      ["DELETE /api/borrows/:id", send(`/api/borrows/${new ObjectId().toString()}`, "DELETE", undefined)],
      ["PUT /api/borrows/:id/return", send(`/api/borrows/${new ObjectId().toString()}/return`, "PUT", undefined)],
      ["PATCH /api/borrows/:id/return", send(`/api/borrows/${new ObjectId().toString()}/return`, "PATCH", undefined)],
    ];
    for (const [label, call] of protectedCalls) {
      const result = await call;
      if (result.status !== 401) check(`${label} → 401`, false, `got ${result.status}`);
      else check(`${label} → 401`, result.body.status === "fail");
    }

    // Forged and expired Bearer credentials never authenticate.
    const forgedResult = await get("/api/my-books", "invalid.signature.value");
    check("invalid Better Auth JWT → 401", forgedResult.status === 401);
    const expiredToken = await makeJwt(aliceId, Math.floor(Date.now() / 1000) - 60);
    const expired = await get("/api/my-books", expiredToken);
    check("expired Better Auth JWT → 401", expired.status === 401);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n5. Forbidden requests → 403, foreign resources untouched");
  {
    const titleBefore = (await books.findOne({ _id: new ObjectId(secureId) }))?.title;

    const patch = await send(`/api/books/${secureId}`, "PATCH", { title: "Bob Was Here" }, bobToken);
    check("403 when another user updates your book", patch.status === 403);
    checkErrorEnvelope("foreign update", patch);

    const put = await send(`/api/books/${secureId}`, "PUT", { title: "Bob Was Here" }, bobToken);
    check("403 via PUT alias too", put.status === 403);

    const del = await send(`/api/books/${secureId}`, "DELETE", undefined, bobToken);
    check("403 when another user deletes your book", del.status === 403);

    const foreignBorrow = await borrows.findOne({ userId: aliceId.toString(), status: "borrowed" });
    const ret = await send(`/api/borrows/${foreignBorrow!._id.toString()}`, "DELETE", undefined, bobToken);
    check("403 when returning someone else's borrow", ret.status === 403);
    checkErrorEnvelope("foreign return", ret);

    check("book unchanged in MongoDB after all attempts",
      (await books.findOne({ _id: new ObjectId(secureId) }))?.title === titleBefore);
    check("borrow still active after foreign return attempt",
      (await borrows.findOne({ _id: foreignBorrow!._id }))?.status === "borrowed");
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n6. Invalid MongoDB ObjectIds → 400, never a database lookup");
  {
    const badIds = ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "%20%20", "g".repeat(24)];
    for (const bad of badIds) {
      const read = await get(`/api/books/${encodeURIComponent(bad)}`);
      check(`GET /api/books/${bad} → 400`, read.status === 400);
      if (bad === badIds[0]) checkErrorEnvelope("invalid id", read);
    }
    const patch = await send(`/api/books/${badIds[0]}`, "PATCH", { title: "X" }, aliceToken);
    check("PATCH with malformed id → 400", patch.status === 400);
    const put = await send(`/api/books/${badIds[1]}`, "PUT", { title: "X" }, aliceToken);
    check("PUT with malformed id → 400", put.status === 400);
    const del = await send(`/api/books/${badIds[2]}`, "DELETE", undefined, aliceToken);
    check("DELETE with malformed id → 400", del.status === 400);
    const retDel = await send(`/api/borrows/${badIds[0]}`, "DELETE", undefined, aliceToken);
    check("DELETE borrow with malformed id → 400", retDel.status === 400);
    const retPut = await send(`/api/borrows/${badIds[1]}/return`, "PUT", undefined, aliceToken);
    check("PUT /return with malformed id → 400", retPut.status === 400);
    const retPatch = await send(`/api/borrows/${badIds[3]}/return`, "PATCH", undefined, aliceToken);
    check("PATCH /return with malformed id → 400", retPatch.status === 400);

    // A well-formed but unknown id is a 404, not a crash.
    const ghost = await get(`/api/books/${new ObjectId().toString()}`);
    check("valid-but-absent id → 404", ghost.status === 404);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n7. CORS behavior");
  {
    const allowedOrigin = env.CORS_ORIGINS[0];
    const allowed = await get("/api/health", undefined, allowedOrigin);
    check(`allowlisted origin (${allowedOrigin}) receives ACAO`,
      allowed.headers.get("access-control-allow-origin") === allowedOrigin);
    check("credentials allowed for allowlisted origin",
      allowed.headers.get("access-control-allow-credentials") === "true");
    check("Vary: Origin present so caches cannot mix origins",
      (allowed.headers.get("vary") ?? "").toLowerCase().includes("origin"));

    const foreign = await get("/api/health", undefined, "https://evil.example");
    check("foreign origin gets NO ACAO header", foreign.headers.get("access-control-allow-origin") === null);
    check("foreign origin still gets a normal response (browser blocks reading)",
      foreign.status === 200 && foreign.body.status === "success");

    const nullOrigin = await get("/api/health", undefined, "null");
    check("Origin: null gets NO ACAO header", nullOrigin.headers.get("access-control-allow-origin") === null);

    const preflight = await request("/api/books", {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    check("preflight from allowlisted origin → 204", preflight.status === 204, `got ${preflight.status}`);
    check("preflight echoes ACAO", preflight.headers.get("access-control-allow-origin") === allowedOrigin);
    check("preflight allows POST", (preflight.headers.get("access-control-allow-methods") ?? "").includes("POST"));
    check("preflight allows content-type", (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().includes("content-type"));

    const evilPreflight = await request("/api/books", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    check("preflight from foreign origin gets NO ACAO", evilPreflight.headers.get("access-control-allow-origin") === null);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n8. Centralized error handler (unit) — 500 never leaks internals");
  {
    type Captured = { statusCode?: number; body?: unknown };
    const makeRes = (headersSent = false): { res: Parameters<typeof errorHandler>[2]; captured: Captured; nextCalls: unknown[] } => {
      const captured: Captured = {};
      const nextCalls: unknown[] = [];
      const res = {
        headersSent,
        status(code: number) { captured.statusCode = code; return this; },
        json(payload: unknown) { captured.body = payload; return this; },
        setHeader() { return this; },
      } as unknown as Parameters<typeof errorHandler>[2];
      return { res, captured, nextCalls };
    };
    const next = (err: unknown): void => { void err; };
    const fakeReq = {} as Parameters<typeof errorHandler>[1];

    // a) Unknown errors → generic 500, even when the message holds secrets.
    {
      const { res, captured } = makeRes();
      const secretish = new Error(
        "connect failed mongodb+srv://alice:SUPERSECRET@cluster.test/db — password=SUPERSECRET"
      );
      errorHandler(secretish, fakeReq, res, next);
      const body = captured.body as Envelope;
      check("unknown error → 500", captured.statusCode === 500);
      check("500 uses status: \"error\"", body.status === "error");
      check("500 message is generic", body.message === "Something went wrong on the server.");
      const raw = JSON.stringify(body);
      check("500 body contains no credentials", !raw.includes("SUPERSECRET") && !raw.includes("mongodb"));
      check("500 body contains no stack", !("stack" in body) && !/\.ts:\d+:\d+/.test(raw));
    }

    // b) ApiError / OperationError → their own status + safe message.
    {
      const { res, captured } = makeRes();
      errorHandler(new OperationError(409, "No copies of this book are currently available."), fakeReq, res, next);
      const body = captured.body as Envelope;
      check("OperationError → 409 with its message",
        captured.statusCode === 409 && body.status === "fail" && body.message === "No copies of this book are currently available.");

      const { res: res2, captured: cap2 } = makeRes();
      errorHandler(new ApiError(409, "Friendly conflict"), fakeReq, res2, next);
      check("ApiError → its status + message",
        cap2.statusCode === 409 && (cap2.body as Envelope).message === "Friendly conflict");
    }

    // c) Body-parser errors → friendly 4xx that never echo the payload.
    {
      const { res, captured } = makeRes();
      errorHandler(
        { type: "entity.too.large", status: 413, expose: true, message: "request entity too large" },
        fakeReq, res, next
      );
      check("entity.too.large → 413", captured.statusCode === 413);
      check("413 has friendly message", (captured.body as Envelope).message === "Request body is too large. Please send a smaller payload.");

      const { res: res2, captured: cap2 } = makeRes();
      errorHandler(
        { type: "entity.parse.failed", status: 400, expose: true, message: "Unexpected token i in JSON at position 0" },
        fakeReq, res2, next
      );
      const raw = JSON.stringify(cap2.body);
      check("entity.parse.failed → 400", cap2.statusCode === 400);
      check("parse error does not echo client payload", !raw.includes("Unexpected token"));
    }

    // d) Escaped ZodError → 400 with the per-field map.
    {
      const parsed = createBookSchema.safeParse({});
      const { res, captured } = makeRes();
      errorHandler(parsed.success ? new Error("unreachable") : parsed.error, fakeReq, res, next);
      const body = captured.body as Envelope;
      check("ZodError → 400 + errors map",
        captured.statusCode === 400 && body.status === "fail" && Object.keys(body.errors ?? {}).includes("title"));
    }

    // e) MongoDB duplicate key → 409, driver message never sent.
    {
      const { res, captured } = makeRes();
      errorHandler(
        { code: 11000, message: "E11000 duplicate key error collection: booknook_security_verification.borrows index: borrows_one_active_per_user_book" },
        fakeReq, res, next
      );
      const body = captured.body as Envelope;
      check("duplicate active borrow → 409",
        captured.statusCode === 409 && body.message === "You already have this book borrowed. Return it before borrowing again.");
      check("no collection/index names leaked", !JSON.stringify(body).includes("E11000"));

      const { res: res2, captured: cap2 } = makeRes();
      errorHandler({ code: 11000, message: "E11000 duplicate key collection: db.users index: email_1" }, fakeReq, res2, next);
      const raw = JSON.stringify(cap2.body);
      check("other duplicate key → generic 409", cap2.statusCode === 409 && (cap2.body as Envelope).status === "fail");
      check("other duplicate key leaks no internals", !raw.includes("E11000") && !raw.includes("email_1"));
    }

    // f) headersSent → delegated instead of double-responding.
    {
      const { res, nextCalls } = makeRes(true);
      const err = new Error("late failure");
      errorHandler(err, fakeReq, res, (e: unknown) => { nextCalls.push(e); });
      check("errors after headers sent are delegated to next", nextCalls.length === 1 && nextCalls[0] === err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n9. Safe logging — secrets scrubbed before printing");
  {
    const mongoScrubbed = sanitizeLogText("failed: mongodb+srv://alice:SUPERSECRET@cluster.test/db");
    check("MongoDB credentials redacted", !mongoScrubbed.includes("SUPERSECRET") && mongoScrubbed.includes("***"));

    const bearerScrubbed = sanitizeLogText("header was Authorization: Bearer SUPERSECRETVALUE");
    check("Bearer tokens redacted", !bearerScrubbed.includes("SUPERSECRETVALUE"));

    const assignmentScrubbed = sanitizeLogText("config BETTER_AUTH_SECRET=SUPERSECRETVALUE loaded");
    check("secret=value assignments redacted", !assignmentScrubbed.includes("SUPERSECRETVALUE"));

    const plain = sanitizeLogText("plain operational message");
    check("ordinary messages stay readable", plain === "plain operational message");
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n10. Rate limiting — 429 + Retry-After on sensitive budgets");
  {
    // Dedicated app with a tiny WRITE budget: the first few requests get
    // normal answers, the rest are rejected with the standard envelope.
    const writeApp = createApp(db, {
      rateLimit: { global: { max: 10_000 }, write: { max: 3 } },
    });
    const writeServer = createServer(writeApp);
    await new Promise<void>((resolve) => writeServer.listen(0, resolve));
    const writeBase = `http://127.0.0.1:${(writeServer.address() as AddressInfo).port}`;

    const writeStatuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${writeBase}/api/borrows`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
        body: JSON.stringify({}),
      });
      writeStatuses.push(res.status);
      if (res.status === 429) {
        const body = (await res.json()) as Envelope;
        errorBodies.push(JSON.stringify(body));
        check("429 uses the standard fail envelope", body.status === "fail" && typeof body.message === "string");
        const retryAfter = res.headers.get("retry-after");
        check("429 sends Retry-After", retryAfter !== null && Number(retryAfter) >= 1, `Retry-After=${retryAfter}`);
      }
    }
    check("first 3 write requests pass the budget", writeStatuses.slice(0, 3).every((s) => s !== 429), writeStatuses.join(","));
    check("requests beyond the write budget get 429", writeStatuses.slice(3).every((s) => s === 429), writeStatuses.join(","));
    await new Promise<void>((resolve, reject) => writeServer.close((err) => (err ? reject(err) : resolve())));

    // Dedicated app with a tiny GLOBAL budget → any endpoint 429s.
    const globalApp = createApp(db, {
      rateLimit: { global: { max: 5 }, write: { max: 10_000 } },
    });
    const globalServer = createServer(globalApp);
    await new Promise<void>((resolve) => globalServer.listen(0, resolve));
    const globalBase = `http://127.0.0.1:${(globalServer.address() as AddressInfo).port}`;

    const globalStatuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${globalBase}/api/health`);
      globalStatuses.push(res.status);
      if (res.status === 429) errorBodies.push(await res.text());
    }
    check("first 5 requests pass the global budget", globalStatuses.slice(0, 5).every((s) => s !== 429), globalStatuses.join(","));
    check("6th request in the window → 429", globalStatuses[5] === 429, `got ${globalStatuses[5]}`);
    await new Promise<void>((resolve, reject) => globalServer.close((err) => (err ? reject(err) : resolve())));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n11. Ownership spoofing attempts are stripped");
  {
    const spoofed = await send(
      "/api/books",
      "POST",
      {
        title: "Spoofed Ownership",
        author: "Mallory",
        category: "Fiction",
        image: "https://evil.test/cover.jpg",
        description: "An attempt to impersonate another owner entirely.",
        quantity: 3,
        addedBy: bobId.toString(),
        addedByName: "Bob Other",
        addedByEmail: "bob@test.local",
        userName: "Bob Other",
        userEmail: "bob@test.local",
        id: new ObjectId().toString(),
        _id: new ObjectId().toString(),
        createdAt: "1999-01-01T00:00:00.000Z",
        availableCopies: 999,
      },
      aliceToken
    );
    check("spoofed create → 201", spoofed.status === 201);
    const created = spoofed.body.data as ApiBook;
    check("owner is the session user, not the body", created.addedBy === aliceId.toString());
    check("owner name/email from session", created.userName === "Alice Owner" && created.userEmail === "alice@test.local");
    check("client cannot set timestamps or counters",
      Date.parse(created.createdAt) > Date.now() - 60_000 && created.availableCopies === 3);

    const spoofUpdate = await send(
      `/api/books/${secureId}`,
      "PATCH",
      { title: "Still Alice's Book", addedBy: bobId.toString(), userEmail: "bob@test.local", availableCopies: 99 },
      aliceToken
    );
    check("spoofed update → 200", spoofUpdate.status === 200);
    const updated = spoofUpdate.body.data as ApiBook;
    check("update cannot transfer ownership", updated.addedBy === aliceId.toString());
    check("update cannot set counters directly", updated.availableCopies === 2, `availableCopies=${updated.availableCopies}`);

    const spoofQuery = await get(`/api/borrows?email=bob@test.local&userId=${bobId.toString()}`, aliceToken);
    const rows = (spoofQuery.body.data as ApiBorrow[]) ?? [];
    check("spoofed list query params ignored — own records only",
      rows.length > 0 && rows.every((r) => r.userId === aliceId.toString()));

    // The email-based identity route must stay unimplemented (404).
    const emailRoute = await get(`/api/books/user/${encodeURIComponent("bob@test.local")}`, aliceToken);
    check("email-based identity route still 404", emailRoute.status === 404);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n12. All API endpoints — happy paths (contract intact)");
  {
    // 1. Health
    const health = await get("/api/health");
    check("GET /api/health → 200", health.status === 200 && health.body.status === "success"
      && typeof health.body.environment === "string" && typeof health.body.timestamp === "string");

    // 2. Public catalog
    const list = await get("/api/books");
    check("GET /api/books → 200 + envelope",
      list.status === 200 && list.body.status === "success" && Array.isArray(list.body.books)
      && typeof list.body.total === "number" && typeof list.body.page === "number"
      && typeof list.body.limit === "number" && typeof list.body.totalPages === "number");

    // 4. Book details
    const detail = await get(`/api/books/${secureId}`);
    check("GET /api/books/:id → 200 + data",
      detail.status === 200 && (detail.body.data as ApiBook).id === secureId);

    // 5. Create
    const created = await send(
      "/api/books",
      "POST",
      { title: "Phase Eight Book", author: "Security Tester", category: "Programming", image: "https://example.com/p8.jpg", description: "Created to prove the create endpoint contract holds.", quantity: 2, rating: 4.2 },
      aliceToken
    );
    check("POST /api/books → 201 + data", created.status === 201 && created.body.status === "success");
    const createdBook = created.body.data as ApiBook;
    check("created book readable publicly", (await get(`/api/books/${createdBook.id}`)).status === 200);

    // 6. Update (PATCH and the frontend's PUT alias)
    const patched = await send(`/api/books/${createdBook.id}`, "PATCH", { title: "Phase Eight Book (Updated)" }, aliceToken);
    check("PATCH /api/books/:id → 200 + data", patched.status === 200 && (patched.body.data as ApiBook).title === "Phase Eight Book (Updated)");
    const put = await send(`/api/books/${createdBook.id}`, "PUT", { rating: 4.9 }, aliceToken);
    check("PUT /api/books/:id → 200 (frontend alias)", put.status === 200 && (put.body.data as ApiBook).rating === 4.9);

    // 7. Delete
    const deleted = await send(`/api/books/${createdBook.id}`, "DELETE", undefined, aliceToken);
    check("DELETE /api/books/:id → 200 + success flag",
      deleted.status === 200 && deleted.body.status === "success" && deleted.body.success === true);
    check("deleted book is gone", (await get(`/api/books/${createdBook.id}`)).status === 404);

    // 8. Borrow
    const borrowed = await send("/api/borrows", "POST", { bookId: deleteMeId, bookTitle: "SPOOFED", userEmail: "spoof@evil.test" }, aliceToken);
    check("POST /api/borrows → 201 + data", borrowed.status === 201 && borrowed.body.status === "success");
    const borrowRow = borrowed.body.data as ApiBorrow;
    check("borrow record built server-side",
      borrowRow.userId === aliceId.toString() && borrowRow.bookTitle === "Delete Me Book"
      && borrowRow.userEmail === "alice@test.local" && borrowRow.status === "borrowed");

    // 9. Borrow list (+ aliases)
    const borrowsList = await get("/api/borrows", aliceToken);
    check("GET /api/borrows → 200 + data array",
      borrowsList.status === 200 && Array.isArray(borrowsList.body.data) && typeof borrowsList.body.total === "number");
    for (const alias of ["/api/my-borrows", "/api/borrows/my", "/api/borrows/user"]) {
      const res = await get(alias, aliceToken);
      check(`${alias} alias → 200`, res.status === 200);
    }
    const myBooks = await get("/api/my-books", aliceToken);
    check("GET /api/my-books → 200 + own books only",
      myBooks.status === 200 && (myBooks.body.books ?? []).every((b) => b.addedBy === aliceId.toString()));
    check("/api/books/my alias → 200", (await get("/api/books/my", aliceToken)).status === 200);
    check("/api/books/user alias → 200", (await get("/api/books/user", aliceToken)).status === 200);

    // 10. Return (DELETE + PUT/PATCH aliases)
    const returned = await send(`/api/borrows/${borrowRow.id}`, "DELETE", undefined, aliceToken);
    check("DELETE /api/borrows/:id → 200 + success flag",
      returned.status === 200 && returned.body.status === "success" && returned.body.success === true);
    check("returned copy is available again",
      (await books.findOne({ _id: new ObjectId(deleteMeId) }))?.availableCopies === 1);

    const borrowedAgain = await send("/api/borrows", "POST", { bookId: deleteMeId }, aliceToken);
    const secondRow = borrowedAgain.body.data as ApiBorrow;
    const putReturn = await send(`/api/borrows/${secondRow.id}/return`, "PUT", undefined, aliceToken);
    check("PUT /api/borrows/:id/return → 200 (frontend alias)", putReturn.status === 200);

    // 404 consistency for unknown routes
    const notFound = await get("/api/definitely-missing");
    check("unknown route → 404 + fail envelope", notFound.status === 404 && notFound.body.status === "fail");
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log("\n13. Global leak sweep across every error response seen");
  {
    check(`collected ${errorBodies.length} error bodies to sweep`, errorBodies.length > 0);
    const joined = errorBodies.join("\n");
    check("no stack frames anywhere", !/\.ts:\d+:\d+/.test(joined) && !joined.includes('"stack"'));
    check("no MongoDB driver internals anywhere", !/E11000|MongoServerError|MongoParseError|collection:/.test(joined));
    check("no connection string anywhere", !joined.includes("mongodb://") && !joined.includes("mongodb+srv://"));
    check("Better Auth secret never echoed", !joined.includes(env.BETTER_AUTH_SECRET));
    check("no MongoDB connection string anywhere",
      !joined.includes("mongodb://") && !joined.includes("mongodb+srv://"));
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
  console.log("🛡️  Phase 8 security & error-handling verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Security verification crashed:", error);
  process.exit(1);
});
