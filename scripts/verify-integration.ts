/**
 * End-to-end REST flow verification against an isolated MongoDB database.
 * Better Auth signs each user's JWT; all API ownership comes from that JWT.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";

const TEST_DB = "booknook_integration_verification";
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

type Account = { id: string; token: string };
type BookResponse = {
  id?: string;
  title?: string;
  quantity?: number;
  availableCopies?: number;
  addedBy?: string;
};
type Envelope = {
  data?: BookResponse & { id?: string };
  books?: BookResponse[];
  message?: string;
  success?: boolean;
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

    const request = async (path: string, init: RequestInit = {}) =>
      fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          origin: frontendOrigin,
          ...(init.headers ?? {}),
        },
      });

    const createAccount = async (label: string): Promise<Account> => {
      const email = `flow-${label}-${Date.now()}@test.local`;
      const password = "BookNook-Flow-Test-Password-123!";
      const signUp = await request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Flow ${label}`, email, password }),
      });
      const signUpBody = (await signUp.json()) as { user?: { id?: string } };
      if (!signUp.ok || !signUpBody.user?.id) {
        throw new Error(`Could not create verification user (${signUp.status}).`);
      }

      const cookie = signUp.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .filter(Boolean)
        .join("; ");
      const tokenResponse = await request("/api/auth/token", {
        headers: { cookie },
      });
      const tokenBody = (await tokenResponse.json()) as { token?: string };
      if (!tokenResponse.ok || !tokenBody.token) {
        throw new Error(`Could not obtain verification JWT (${tokenResponse.status}).`);
      }
      return { id: signUpBody.user.id, token: tokenBody.token };
    };

    const owner = await createAccount("owner");
    const borrower = await createAccount("borrower");
    const otherUser = await createAccount("other");
    const auth = (account: Account) => ({
      authorization: `Bearer ${account.token}`,
    });

    console.log("\n1. Add and list a user's own book");
    const create = await request("/api/books", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Atomic Flow Book",
        author: "Integration Author",
        category: "Fiction",
        image: "https://example.com/atomic-flow.jpg",
        quantity: 1,
        description: "An integration-test book for secure borrow flows.",
        addedBy: borrower.id,
        userEmail: "spoofed@example.com",
      }),
    });
    const created = (await create.json()) as Envelope;
    const bookId = created.data?.id;
    check("a regular authenticated user can add a book", create.status === 201);
    check("the verified subject is recorded as book owner", created.data?.addedBy === owner.id);

    const mine = await request("/api/my-books", { headers: auth(owner) });
    const mineBody = (await mine.json()) as Envelope;
    check("My Books returns the authenticated user's book", mine.ok && mineBody.books?.some((book) => book.id === bookId));

    console.log("\n2. Public catalog, details, and owner-only edits");
    const catalog = await request("/api/books");
    const details = await request(`/api/books/${bookId}`);
    check("book catalog is public", catalog.ok);
    check("book details are public", details.ok);

    const editByOther = await request(`/api/books/${bookId}`, {
      method: "PATCH",
      headers: { ...auth(borrower), "content-type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized Edit" }),
    });
    const editByOwner = await request(`/api/books/${bookId}`, {
      method: "PATCH",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ title: "Atomic Flow Book Updated" }),
    });
    check("another user cannot edit the book", editByOther.status === 403);
    check("the owner can edit the book", editByOwner.ok);

    console.log("\n3. Borrow limits, ownership, and returns");
    const returnDate = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const borrow = async (account: Account) =>
      request("/api/borrows", {
        method: "POST",
        headers: { ...auth(account), "content-type": "application/json" },
        body: JSON.stringify({ bookId, returnDate, userId: owner.id, userEmail: "spoofed@example.com" }),
      });

    const firstBorrow = await borrow(borrower);
    const firstBorrowBody = (await firstBorrow.json()) as Envelope & { data?: { id?: string } };
    const borrowId = firstBorrowBody.data?.id;
    const duplicateBorrow = await borrow(borrower);
    const noCopiesBorrow = await borrow(otherUser);
    check("an available copy can be borrowed", firstBorrow.status === 201);
    check("the same user cannot borrow the same book twice", duplicateBorrow.status === 409);
    check("another user cannot borrow when no copies remain", noCopiesBorrow.status === 409);

    const returnByOther = await request(`/api/borrows/${borrowId}`, {
      method: "DELETE",
      headers: auth(otherUser),
    });
    const returnByBorrower = await request(`/api/borrows/${borrowId}`, {
      method: "DELETE",
      headers: auth(borrower),
    });
    const duplicateReturn = await request(`/api/borrows/${borrowId}`, {
      method: "DELETE",
      headers: auth(borrower),
    });
    check("another user cannot return the borrow", returnByOther.status === 403);
    check("the borrower can return the book", returnByBorrower.ok);
    check("a borrow cannot be returned twice", duplicateReturn.status === 409);

    const secondBorrow = await borrow(otherUser);
    const secondBorrowBody = (await secondBorrow.json()) as Envelope & { data?: { id?: string } };
    const secondReturn = await request(`/api/borrows/${secondBorrowBody.data?.id}`, {
      method: "DELETE",
      headers: auth(otherUser),
    });
    const afterReturn = await request(`/api/books/${bookId}`);
    const afterReturnBody = (await afterReturn.json()) as Envelope;
    check("returned copies become available to another user", secondBorrow.status === 201 && secondReturn.ok);
    check("return restores available-copy count", afterReturnBody.data?.availableCopies === 1);

    const deleteByOther = await request(`/api/books/${bookId}`, {
      method: "DELETE",
      headers: auth(borrower),
    });
    const deleteByOwner = await request(`/api/books/${bookId}`, {
      method: "DELETE",
      headers: auth(owner),
    });
    check("another user cannot delete the book", deleteByOther.status === 403);
    check("the owner can delete a book after all borrows are returned", deleteByOwner.ok);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.db(TEST_DB).dropDatabase();
    await client.close();
  }
};

run().catch((error: unknown) => {
  console.error("❌ Integration verification failed.", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
