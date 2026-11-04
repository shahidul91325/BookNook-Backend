/**
 * Verifies the Express Better Auth server, official JWT endpoint, and JWT
 * protected API using a throwaway MongoDB database.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient } from "mongodb";
import createApp from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { env } from "../src/config/env.js";

const TEST_DB = "booknook_auth_verification";
let passed = 0;
let failed = 0;

const check = (label: string, condition: boolean): void => {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}`);
  }
};

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);
  const server: Server = createServer(createApp(db));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const apiUrl = `http://127.0.0.1:${port}`;
    process.env.JWT_JWKS_URL = `${apiUrl}/api/auth/jwks`;
    const frontendOrigin = new URL(env.BETTER_AUTH_URL).origin;
    const email = `auth-${Date.now()}@test.local`;
    const password = "BookNook-Test-Password-123!";
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          origin: frontendOrigin,
          ...(init.headers ?? {}),
        },
      });

    const anonymousToken = await request("/api/auth/token");
    check("JWT token endpoint requires an active session before registration", anonymousToken.status === 401);

    console.log("\n1. Email/password sign-up and session persistence");
    const avatarUrl = "https://i.ibb.co/verification/avatar.png";
    const signUp = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "JWT Verification User", email, password, image: avatarUrl }),
    });
    const signUpBody = (await signUp.json().catch(() => null)) as
      | { user?: { id?: string } }
      | null;
    const cookieParts = signUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .filter(Boolean);
    check("Express Better Auth handles email sign-up", signUp.ok);
    check("sign-up returns the stable user id", Boolean(signUpBody?.user?.id));
    check("sign-up sets the session cookie", cookieParts.length > 0);
    const persistedUser = await db.collection("user").findOne({ email });
    check("registration persists the supplied avatar URL to Better Auth user.image", persistedUser?.image === avatarUrl);

    const cookie = cookieParts.join("; ");
    const tokenResponse = await request("/api/auth/token", {
      headers: { cookie },
    });
    const tokenBody = (await tokenResponse.json().catch(() => null)) as
      | { token?: string }
      | null;
    check("official JWT plugin token endpoint succeeds", tokenResponse.ok);
    check("JWT plugin returns a compact JWT", Boolean(tokenBody?.token?.split(".").length === 3));

    const protectedHeaders = {
      authorization: `Bearer ${tokenBody?.token ?? ""}`,
    };
    console.log("\n2. Protected book API token verification");
    const missing = await request("/api/my-books");
    const invalid = await request("/api/my-books", {
      headers: { authorization: "Bearer invalid.jwt.value" },
    });
    const expiredPayload = await createAuth(db).api.signJWT({
      body: {
        payload: {
          sub: signUpBody?.user?.id ?? "missing-user",
          iat: Math.floor(Date.now() / 1000) - 600,
          exp: Math.floor(Date.now() / 1000) - 300,
        },
      },
    });
    const expired = await request("/api/my-books", {
      headers: { authorization: `Bearer ${expiredPayload.token}` },
    });
    check("missing JWT is rejected with 401", missing.status === 401);
    check("invalid JWT is rejected with 401", invalid.status === 401);
    check("expired JWT is rejected with 401", expired.status === 401);

    const createBook = await request("/api/books", {
      method: "POST",
      headers: {
        ...protectedHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "JWT Owned Book",
        author: "Verification Author",
        category: "Fiction",
        image: "https://example.com/jwt-book.jpg",
        quantity: 1,
        description: "A book created while verifying Better Auth JWT ownership.",
        addedBy: "forged-client-owner",
        userEmail: "forged@example.com",
      }),
    });
    const createdBody = (await createBook.json().catch(() => null)) as
      | { data?: { addedBy?: string; userEmail?: string } }
      | null;
    check("valid JWT can create a book", createBook.status === 201);
    check(
      "book owner comes from the verified JWT subject",
      createdBody?.data?.addedBy === signUpBody?.user?.id &&
        createdBody?.data?.userEmail !== "forged@example.com"
    );

    const myBooksResponse = await request("/api/my-books", {
      headers: protectedHeaders,
    });
    const myBooksBody = (await myBooksResponse.json().catch(() => null)) as
      | { books?: Array<{ title?: string; addedBy?: string }> }
      | null;
    check("valid JWT can read its own books", myBooksResponse.ok);
    check(
      "My Books contains only the verified user's new book",
      myBooksBody?.books?.some(
        (book) => book.title === "JWT Owned Book" && book.addedBy === signUpBody?.user?.id
      ) === true
    );

    console.log("\n3. Sign-out revokes the cookie-backed session");
    const signOut = await request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie },
    });
    const sessionAfterSignOut = await request("/api/auth/get-session", {
      headers: { cookie },
    });
    const sessionBody = (await sessionAfterSignOut.json().catch(() => null)) as
      | { user?: { id?: string } }
      | null;
    const tokenAfterSignOut = await request("/api/auth/token", {
      headers: { cookie },
    });
    check("Better Auth sign-out succeeds", signOut.ok);
    check("session lookup no longer returns a user", !sessionBody?.user);
    check("JWT endpoint cannot mint a token after sign-out", !tokenAfterSignOut.ok);

    const signIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const signInCookies = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .filter(Boolean);
    const signedInSession = await request("/api/auth/get-session", {
      headers: { cookie: signInCookies.join("; ") },
    });
    const signedInSessionBody = (await signedInSession.json().catch(() => null)) as
      | { user?: { id?: string } }
      | null;
    check("email/password sign-in succeeds", signIn.ok);
    check(
      "new session cookie persists across a follow-up request",
      signedInSessionBody?.user?.id === signUpBody?.user?.id
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.db(TEST_DB).dropDatabase();
    await client.close();
  }
};

run().catch((error: unknown) => {
  console.error("❌ Auth verification failed.", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
