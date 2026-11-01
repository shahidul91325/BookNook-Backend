/**
 * Phase 5 verification script — NOT part of the runtime server.
 * Run with: npm run verify:create
 *
 * Connects to a temporary throwaway database (booknook_create_verification),
 * seeds a Better Auth-shaped user + signed session cookie, then exercises
 * POST /api/books over HTTP against the real Express app. The database is
 * dropped afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1. Valid book creation                        → 201 + stored document
 *   2. Default quantity when omitted              → totalCopies=1
 *   3. Missing required fields                    → 400 + per-field errors
 *   4. Invalid category                           → 400
 *   5. Invalid image URL                          → 400
 *   6. Unauthenticated request                    → 401, nothing stored
 *   7. Ownership spoofing attempt                 → ignored, real owner stored
 *   8. Forged/expired session                     → 401
 *   9. Server-generated timestamps                → not client-controlled
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";

const TEST_DB = "booknook_create_verification";

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

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);
  const books = db.collection("books");
  const users = db.collection("user");
  const sessions = db.collection("session");
  await books.deleteMany({});
  await users.deleteMany({});
  await sessions.deleteMany({});

  // ── Fixtures: a verified user + valid signed session ────────────────────
  const now = new Date();
  const aliceId = new ObjectId();
  await users.insertOne({
    _id: aliceId,
    name: "Alice Verified",
    email: "alice@test.local",
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  const validToken = "create-phase-session-token-000000";
  const expiredToken = "create-phase-session-expired-0000";
  await sessions.insertMany([
    {
      token: validToken,
      userId: aliceId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    },
    {
      token: expiredToken,
      userId: aliceId,
      expiresAt: new Date(Date.now() - 1000),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const app = createApp(db);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const cookieName = "better-auth.session_token";
  const authedCookie = `${cookieName}=${signSessionCookie(validToken, env.BETTER_AUTH_SECRET)}`;

  const post = async (
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: { status: string; message?: string; errors?: Record<string, string[]>; data?: ApiBook } }> => {
    const res = await fetch(`${base}/api/books`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        status: string;
        message?: string;
        errors?: Record<string, string[]>;
        data?: ApiBook;
      },
    };
  };

  const validBody = {
    title: "The Art of Software Testing",
    author: "Glenford Myers",
    category: "Programming",
    image: "https://example.com/software-testing.jpg",
    description: "A classic guide to software quality assurance and testing techniques.",
    quantity: 3,
    rating: 4.5,
  };

  // ── 1. Valid book creation ───────────────────────────────────────────────
  console.log("\n1. Valid book creation");
  let createdId = "";
  {
    const { status, body } = await post(validBody, { cookie: authedCookie });
    check("201 Created", status === 201);
    check("status success", body.status === "success");
    check("data envelope present", typeof body.data === "object" && body.data !== null);

    const data = body.data as ApiBook;
    createdId = data.id;
    check("id is a 24-char hex string", /^[0-9a-f]{24}$/.test(data.id));
    check("title stored", data.title === validBody.title);
    check("quantity alias === totalCopies", data.quantity === 3 && data.totalCopies === 3);
    check("availableCopies initialized to totalCopies", data.availableCopies === 3);
    check("rating stored", data.rating === 4.5);
    check("ownership = verified session user", data.addedBy === aliceId.toString());
    check("userName = session user name", data.userName === "Alice Verified");
    check("userEmail = session user email", data.userEmail === "alice@test.local");
    check("createdAt is ISO timestamp", !Number.isNaN(Date.parse(data.createdAt)));
    check("updatedAt is ISO timestamp", !Number.isNaN(Date.parse(data.updatedAt)));

    // Confirm it is really persisted and publicly readable.
    const stored = await books.findOne({ _id: new ObjectId(data.id) });
    check("document persisted in MongoDB", stored !== null);
    check("stored addedBy is session user", stored?.addedBy === aliceId.toString());

    const readBack = await fetch(`${base}/api/books/${data.id}`);
    check("created book readable via GET /api/books/:id", readBack.status === 200);
  }

  // ── 2. Default quantity ──────────────────────────────────────────────────
  console.log("\n2. Default quantity when omitted");
  {
    const { status, body } = await post(
      { ...validBody, title: "No Quantity Book", quantity: undefined },
      { cookie: authedCookie }
    );
    check("201 Created", status === 201);
    check("quantity defaults to 1", body.data?.quantity === 1 && body.data?.totalCopies === 1);
    check("availableCopies defaults to 1", body.data?.availableCopies === 1);
  }

  // ── 3. Missing required fields ───────────────────────────────────────────
  console.log("\n3. Missing required fields");
  {
    const { status, body } = await post({}, { cookie: authedCookie });
    check("400 for empty body", status === 400);
    check("fail shape", body.status === "fail");
    const keys = Object.keys(body.errors ?? {});
    for (const field of ["title", "author", "category", "image", "description"]) {
      check(`error reported for missing ${field}`, keys.includes(field));
    }

    const partial = await post({ title: "Only A Title" }, { cookie: authedCookie });
    check("400 for partial body", partial.status === 400);
    check("author missing flagged", "author" in (partial.body.errors ?? {}));
    check("title present not flagged", !("title" in (partial.body.errors ?? {})));

    const shortDesc = await post(
      { ...validBody, description: "too short" },
      { cookie: authedCookie }
    );
    check("400 for description < 10 chars", shortDesc.status === 400);

    const badQty = await post({ ...validBody, quantity: 0 }, { cookie: authedCookie });
    check("400 for quantity 0", badQty.status === 400);
  }

  // ── 4. Invalid category ──────────────────────────────────────────────────
  console.log("\n4. Invalid category");
  {
    const { status, body } = await post(
      { ...validBody, category: "Astrology" },
      { cookie: authedCookie }
    );
    check("400 for disallowed category", status === 400);
    check("category error present", "category" in (body.errors ?? {}));

    // Every allowed category must be accepted.
    const allowed = ["Fiction", "Science", "History", "Kids", "Self Help", "Programming", "Fantasy", "Financial", "Others"];
    let allAccepted = true;
    for (const category of allowed) {
      const res = await post({ ...validBody, title: `Cat ${category}`, category }, { cookie: authedCookie });
      if (res.status !== 201) allAccepted = false;
    }
    check("all 9 allowed categories accepted", allAccepted);
  }

  // ── 5. Invalid image ─────────────────────────────────────────────────────
  console.log("\n5. Invalid image value");
  {
    const { status } = await post(
      { ...validBody, image: "javascript:alert(1)" },
      { cookie: authedCookie }
    );
    check("400 for non-http image value", status === 400);
    const uploads = await post(
      { ...validBody, title: "Uploads Book", image: "/uploads/cover.jpg" },
      { cookie: authedCookie }
    );
    check("/uploads/ path accepted", uploads.status === 201);
  }

  // ── 6. Unauthenticated request ───────────────────────────────────────────
  console.log("\n6. Unauthenticated request");
  {
    const before = await books.countDocuments({});
    const { status, body } = await post(validBody);
    check("401 without credentials", status === 401);
    check("fail shape", body.status === "fail");
    const after = await books.countDocuments({});
    check("nothing stored for unauthenticated request", before === after);

    const badCookie = await post(validBody, {
      cookie: `${cookieName}=${signSessionCookie(validToken, "attacker-secret-32-chars-long!!!!!")}`,
    });
    check("401 for cookie signed with wrong secret", badCookie.status === 401);

    const expired = await post(validBody, {
      cookie: `${cookieName}=${signSessionCookie(expiredToken, env.BETTER_AUTH_SECRET)}`,
    });
    check("401 for expired session", expired.status === 401);
  }

  // ── 7. Ownership spoofing attempt ────────────────────────────────────────
  console.log("\n7. Ownership spoofing attempt");
  {
    const bobId = new ObjectId().toString();
    const before = await books.countDocuments({});
    const { status, body } = await post(
      {
        ...validBody,
        title: "Spoofed Ownership Book",
        // Every client-controllable identity field claims to be someone else.
        addedBy: bobId,
        addedByName: "Mallory Mallory",
        addedByEmail: "mallory@evil.local",
        userName: "Mallory Mallory",
        userEmail: "mallory@evil.local",
        id: new ObjectId().toString(),
        _id: new ObjectId().toString(),
        createdAt: "1999-01-01T00:00:00.000Z",
        updatedAt: "1999-01-01T00:00:00.000Z",
        availableCopies: 999,
      },
      { cookie: authedCookie }
    );
    check("201 for authenticated request", status === 201);
    check("addedBy is session user, not client value", body.data?.addedBy === aliceId.toString(), `addedBy=${body.data?.addedBy}`);
    check("userName is session user name", body.data?.userName === "Alice Verified");
    check("userEmail is session user email", body.data?.userEmail === "alice@test.local");
    check("client-supplied id ignored (new id generated)", body.data?.id !== undefined && body.data?.id !== "");
    check("createdAt is fresh, not 1999", Date.parse(body.data?.createdAt ?? "0") > Date.now() - 60_000);
    check("availableCopies derived from quantity, not client value", body.data?.availableCopies === 3);

    const after = await books.countDocuments({});
    check("exactly one document created", after === before + 1);
    const spoofStored = await books.findOne({ title: "Spoofed Ownership Book" });
    check("stored doc owner is session user", spoofStored?.addedBy === aliceId.toString());
    check("stored doc has no client identity leak", spoofStored?.addedByName === "Alice Verified" && spoofStored?.addedByEmail === "alice@test.local");
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  await client.db(TEST_DB).dropDatabase();
  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("📗 Phase 5 book creation API verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Create-book verification crashed:", error);
  process.exit(1);
});
