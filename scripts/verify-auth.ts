/**
 * Phase 3 verification script — NOT part of the runtime server.
 * Run with: npm run verify:auth
 *
 * Connects to a temporary throwaway database (booknook_auth_verification),
 * inserts Better Auth-shaped user/session documents, then exercises the
 * real Express app + authentication middleware over HTTP. The database is
 * dropped afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1. Missing credentials                     → 401
 *   2. Invalid credentials (garbage / forged)   → 401
 *   3. Tampered signed cookie                   → 401
 *   4. Unknown session token                    → 401
 *   5. Expired session                          → 401
 *   6. Valid signed cookie                      → 200 + correct identity
 *   7. Valid signed Bearer token                → 200
 *   8. Valid opaque Bearer token                → 200
 *   9. Identity spoofing attempts               → ignored, 200 as real user
 *  10. Consistent 401/403 response shapes
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";
import { sendForbidden, sendUnauthorized } from "../src/middleware/auth.js";

const TEST_DB = "booknook_auth_verification";

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

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);

  const users = db.collection("user");
  const sessions = db.collection("session");
  await users.deleteMany({});
  await sessions.deleteMany({});

  // ── Fixtures ────────────────────────────────────────────────────────────
  const now = new Date();
  const aliceId = new ObjectId();
  const bobId = new ObjectId();

  await users.insertMany([
    {
      _id: aliceId,
      name: "Alice Verified",
      email: "alice@test.local",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: bobId,
      name: "Bob Verified",
      email: "bob@test.local",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const validToken = "test-session-token-alice-0000000000";
  const expiredToken = "test-session-token-expired-00000000";
  const bobToken = "test-session-token-bob-000000000000";

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
      expiresAt: new Date(Date.now() - 1000), // already expired
      createdAt: now,
      updatedAt: now,
    },
    {
      token: bobToken,
      userId: bobId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // ── Boot the real app against the throwaway database ────────────────────
  const app = createApp(db);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const secret = env.BETTER_AUTH_SECRET;
  const cookieName = "better-auth.session_token";

  const getMe = async (headers: Record<string, string>) => {
    const res = await fetch(`${base}/api/auth/me`, { headers });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  console.log("\n1. Missing credentials");
  {
    const { status, body } = await getMe({});
    check("401 without any credentials", status === 401);
    check(
      "consistent fail shape",
      (body as { status?: string })?.status === "fail"
    );
  }

  console.log("\n2. Invalid credentials");
  {
    const garbage = await getMe({ authorization: "Bearer not-a-real-token" });
    check("401 for garbage bearer token", garbage.status === 401);

    const forged = await getMe({
      authorization: "Bearer totally.fake.value",
    });
    check("401 for forged signed bearer token", forged.status === 401);

    const wrongScheme = await getMe({ authorization: "Basic dXNlcjpwYXNz" });
    check("401 for non-bearer authorization scheme", wrongScheme.status === 401);

    // Cookie signed with a DIFFERENT (attacker) secret must not verify.
    const attackerSigned = signSessionCookie(validToken, "attacker-secret-32-chars-long!!!!!");
    const forgedCookie = await getMe({ cookie: `${cookieName}=${attackerSigned}` });
    check("401 for cookie signed with wrong secret", forgedCookie.status === 401);
  }

  console.log("\n3. Tampered signed cookie");
  {
    // Valid signature over a DIFFERENT token: signature must not transfer.
    const validSignature = createHmac("sha256", secret)
      .update(validToken)
      .digest("base64");
    const tampered = encodeURIComponent(`tampered-token.${validSignature}`);
    const { status } = await getMe({ cookie: `${cookieName}=${tampered}` });
    check("401 when token is swapped but signature kept", status === 401);

    const garbageCookie = await getMe({ cookie: `${cookieName}=not.signed` });
    check("401 for structurally invalid cookie value", garbageCookie.status === 401);
  }

  console.log("\n4. Unknown session token");
  {
    const unknown = signSessionCookie("session-token-never-in-db-0000", secret);
    const { status } = await getMe({ cookie: `${cookieName}=${unknown}` });
    check("401 for validly-signed token absent from session store", status === 401);
  }

  console.log("\n5. Expired session");
  {
    const expired = signSessionCookie(expiredToken, secret);
    const { status } = await getMe({ cookie: `${cookieName}=${expired}` });
    check("401 for expired session", status === 401);
  }

  console.log("\n6. Valid authenticated user (signed cookie)");
  {
    const signed = signSessionCookie(validToken, secret);
    const { status, body } = await getMe({ cookie: `${cookieName}=${signed}` });
    const data = (body as { data?: { id?: string; email?: string; name?: string } })?.data;
    check("200 for valid session", status === 200);
    check("stable user id matches DB user", data?.id === aliceId.toString(), `id=${data?.id}`);
    check("email is the DB email", data?.email === "alice@test.local");
    check("name is the DB name", data?.name === "Alice Verified");
  }

  console.log("\n7 & 8. Valid Bearer tokens");
  {
    const signedBearer = signSessionCookie(validToken, secret);
    const bearer = await getMe({ authorization: `Bearer ${signedBearer}` });
    check("200 for signed bearer token", bearer.status === 200);

    const opaque = await getMe({ authorization: `Bearer ${validToken}` });
    check("200 for opaque bearer session token", opaque.status === 200);
  }

  console.log("\n9. Attempted user identity spoofing");
  {
    const signed = signSessionCookie(validToken, secret);
    // Alice's valid session, but every client-controllable identity field
    // claims to be Bob.
    const spoofed = await fetch(`${base}/api/auth/me?userId=${bobId}&email=bob@test.local`, {
      headers: {
        cookie: `${cookieName}=${signed}`,
        "x-user-id": bobId.toString(),
        "x-user-email": "bob@test.local",
        "x-forwarded-user": bobId.toString(),
      },
    });
    const body: { data?: { id?: string; email?: string } } = await spoofed.json();
    check("200 for a real session", spoofed.status === 200);
    check(
      "server ignores client-claimed userId/email",
      body.data?.id === aliceId.toString() && body.data?.email === "alice@test.local",
      `resolved id=${body.data?.id}`
    );

    // Spoof attempt via POST body is equally irrelevant (route never reads it).
    const post = await fetch(`${base}/api/auth/me`, {
      method: "POST",
      headers: {
        cookie: `${cookieName}=${signed}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: bobId.toString(), email: "bob@test.local" }),
    });
    // POST /api/auth/me is not a defined route → 404, never 200-as-Bob.
    check("POST identity injection does not authenticate as anyone else", post.status === 404);
  }

  console.log("\n10. Consistent 401/403 shapes");
  {
    const unauthorizedCalls: unknown[] = [];
    const forbiddenCalls: unknown[] = [];
    const fakeRes = (store: unknown[]) =>
      ({
        status(code: number) {
          store.push(["status", code]);
          return this;
        },
        json(payload: unknown) {
          store.push(["json", payload]);
          return this;
        },
      }) as unknown as Parameters<typeof sendUnauthorized>[0];

    sendUnauthorized(fakeRes(unauthorizedCalls));
    sendForbidden(fakeRes(forbiddenCalls));

    const uStatus = unauthorizedCalls.find((c) => (c as string[])[0] === "status")?.[1];
    const uBody = unauthorizedCalls.find((c) => (c as string[])[0] === "json")?.[1] as { status?: string };
    const fStatus = forbiddenCalls.find((c) => (c as string[])[0] === "status")?.[1];
    const fBody = forbiddenCalls.find((c) => (c as string[])[0] === "json")?.[1] as { status?: string };

    check("401 helper emits status 401 + fail shape", uStatus === 401 && uBody?.status === "fail");
    check("403 helper emits status 403 + fail shape", fStatus === 403 && fBody?.status === "fail");
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
  console.log("🔒 Phase 3 auth verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Auth verification crashed:", error);
  process.exit(1);
});
