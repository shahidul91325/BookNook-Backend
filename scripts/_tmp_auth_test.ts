import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { env } from "../dist/src/config/env.js";
import createApp from "../dist/src/app.js";

// Helper: base64url encode
const b64u = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Manual JWT sign for testing (since signJwt may not be exported)
const makeJwt = (payload: Record<string, unknown>, secret: string): string => {
  const header = b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${body}.${sig}`;
};

const makeOpaqueCookie = (token: string, secret: string): string => {
  const sig = createHmac("sha256", secret)
    .update(token, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${sig}`)}`;
};

const client = new MongoClient(env.MONGODB_URI);
await client.connect();
const db = client.db(env.DB_NAME);

const users = db.collection("user");
const sessions = db.collection("session");

// Seed a regular user
const regularUserId = new ObjectId();
await users.insertOne({
  _id: regularUserId,
  name: "Regular User",
  email: "regular@example.com",
  emailVerified: true,
  role: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Seed an admin user
const adminUserId = new ObjectId();
await users.insertOne({
  _id: adminUserId,
  name: "Admin User",
  email: "admin@example.com",
  emailVerified: true,
  role: "admin",
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Create sessions for both
const regularToken = `regular_opaque_token_${regularUserId}`;
await sessions.insertOne({
  _id: new ObjectId(),
  token: regularToken,
  userId: regularUserId,
  expiresAt: new Date(Date.now() + 86400000),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const adminToken = `admin_opaque_token_${adminUserId}`;
await sessions.insertOne({
  _id: new ObjectId(),
  token: adminToken,
  userId: adminUserId,
  expiresAt: new Date(Date.now() + 86400000),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const app = createApp(db);
const server = createServer(app);
server.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const http = await import("node:http");

  const request = (
    path: string,
    method: string = "GET",
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${path}`,
        { method, headers },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });

  const jsonBody = (obj: Record<string, unknown>) => JSON.stringify(obj);

  let passed = 0;
  let failed = 0;
  const check = (name: string, actual: any, expected: any) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      failed++;
    }
  };

  try {
    console.log("\n=== Public routes (no auth) ===");
    const root = await request("/");
    check("GET / status", root.status, 200);
    const health = await request("/api/health");
    check("GET /api/health status", health.status, 200);

    console.log("\n=== Protected routes without auth (should 401) ===");
    const noAuthBooks = await request("/api/books");
    check("GET /api/books no auth (public read - should 200)", noAuthBooks.status, 200);
    const noAuthCreate = await request("/api/books", "POST", {}, jsonBody({ title: "x", author: "y", category: "Fiction", image: "/uploads/x.png", description: "desc", quantity: 1 }));
    check("POST /api/books no auth → 401", noAuthCreate.status, 401);

    console.log("\n=== Regular user (opaque token cookie) ===");
    const regularCookie = makeOpaqueCookie(regularToken, env.BETTER_AUTH_SECRET);
    const meRegular = await request("/api/auth/me", "GET", { Cookie: regularCookie });
    check("GET /api/auth/me regular user → 200", meRegular.status, 200);
    if (meRegular.status === 200) {
      const meData = JSON.parse(meRegular.body);
      check("Regular user role is 'user'", meData.data.user.role, "user");
    }

    const createRegular = await request("/api/books", "POST", { Cookie: regularCookie }, jsonBody({ title: "x", author: "y", category: "Fiction", image: "/uploads/x.png", description: "desc", quantity: 1 }));
    check("POST /api/books regular user → 403", createRegular.status, 403);

    console.log("\n=== Admin user (opaque token cookie) ===");
    const adminCookie = makeOpaqueCookie(adminToken, env.BETTER_AUTH_SECRET);
    const meAdmin = await request("/api/auth/me", "GET", { Cookie: adminCookie });
    check("GET /api/auth/me admin → 200", meAdmin.status, 200);
    if (meAdmin.status === 200) {
      const meData = JSON.parse(meAdmin.body);
      check("Admin user role is 'admin'", meData.data.user.role, "admin");
    }

    const createAdmin = await request("/api/books", "POST", { Cookie: adminCookie }, jsonBody({ title: "Test Book", author: "Test Author", category: "Fiction", image: "/uploads/test.png", description: "A test book", quantity: 5 }));
    check("POST /api/books admin → 201", createAdmin.status, 201);
    let bookId = "";
    if (createAdmin.status === 201) {
      const data = JSON.parse(createAdmin.body);
      bookId = data.data.id;
      check("Book has id", typeof bookId === "string" && bookId.length > 0, true);
    }

    // Update book as admin
    if (bookId) {
      const updateAdmin = await request(`/api/books/${bookId}`, "PATCH", { Cookie: adminCookie }, jsonBody({ title: "Updated Book" }));
      check("PATCH /api/books/:id admin → 200", updateAdmin.status, 200);

      // Delete book as admin
      const deleteAdmin = await request(`/api/books/${bookId}`, "DELETE", { Cookie: adminCookie });
      check("DELETE /api/books/:id admin → 200", deleteAdmin.status, 200);
    }

    console.log("\n=== Admin user (JWT Bearer token) ===");
    const now = Math.floor(Date.now() / 1000);
    const adminJwt = makeJwt(
      {
        sub: adminUserId.toString(),
        role: "admin",
        iat: now,
        exp: now + 3600,
        iss: env.JWT_ISSUER,
        aud: env.JWT_AUDIENCE,
      },
      env.JWT_SECRET
    );
    const meAdminJwt = await request("/api/auth/me", "GET", { Authorization: `Bearer ${adminJwt}` });
    check("GET /api/auth/me JWT admin → 200", meAdminJwt.status, 200);
    if (meAdminJwt.status === 200) {
      const data = JSON.parse(meAdminJwt.body);
      check("JWT admin role is 'admin'", data.data.user.role, "admin");
    }

    const createAdminJwt = await request("/api/books", "POST", { Authorization: `Bearer ${adminJwt}` }, jsonBody({ title: "JWT Book", author: "JWT Author", category: "Fiction", image: "/uploads/jwt.png", description: "JWT test", quantity: 3 }));
    check("POST /api/books JWT admin → 201", createAdminJwt.status, 201);

    console.log("\n=== Invalid JWT (should 401) ===");
    const badJwt = await request("/api/auth/me", "GET", { Authorization: "Bearer invalid.jwt.token" });
    check("GET /api/auth/me bad JWT → 401", badJwt.status, 401);

    console.log("\n=== Expired JWT (should 401) ===");
    const expiredJwt = makeJwt(
      { sub: adminUserId.toString(), role: "admin", iat: now - 7200, exp: now - 3600, iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE },
      env.JWT_SECRET
    );
    const expiredResp = await request("/api/auth/me", "GET", { Authorization: `Bearer ${expiredJwt}` });
    check("GET /api/auth/me expired JWT → 401", expiredResp.status, 401);

    console.log("\n=== Wrong issuer JWT (should 401) ===");
    const wrongIssuerJwt = makeJwt(
      { sub: adminUserId.toString(), role: "admin", iat: now, exp: now + 3600, iss: "wrong-issuer", aud: env.JWT_AUDIENCE },
      env.JWT_SECRET
    );
    const wrongIssuerResp = await request("/api/auth/me", "GET", { Authorization: `Bearer ${wrongIssuerJwt}` });
    check("GET /api/auth/me wrong issuer JWT → 401", wrongIssuerResp.status, 401);

  } catch (err) {
    console.error("Test error:", err);
  } finally {
    server.close(() => {
      client.close().then(() => {
        console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
        process.exit(failed > 0 ? 1 : 0);
      });
    });
  }
});
