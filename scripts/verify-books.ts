/**
 * Phase 4 verification script — NOT part of the runtime server.
 * Run with: npm run verify:books
 *
 * Connects to a temporary throwaway database (booknook_book_verification),
 * seeds real MongoDB documents, then exercises the public book read APIs
 * over HTTP against the real Express app. The database is dropped
 * afterwards so no test data ever lingers.
 *
 * Covered cases:
 *   1. GET /api/books on an empty collection        → 200, empty list
 *   2. GET /api/books returns real documents        → 200, correct fields
 *   3. Newest-first default sorting                 → createdAt desc
 *   4. sort=oldest                                   → createdAt asc
 *   5. sort=title-asc / title-desc                   → case-insensitive order
 *   6. sort=quantity-desc                            → totalCopies desc
 *   7. Unknown sort value                            → falls back to newest
 *   8. Category filtering                            → only matching category
 *   9. "All"/empty category                          → no filtering
 *  10. Search (title + author, case-insensitive)     → regex-safe
 *  11. Pagination limit + page                       → correct slice + totals
 *  12. limit above cap                               → clamped, no crash
 *  13. GET /api/books/:id valid                      → 200 + correct book
 *  14. GET /api/books/:id missing (valid ObjectId)   → 404
 *  15. GET /api/books/:id malformed id               → 400, no crash
 *  16. Regex metacharacters in search                → no crash, no injection
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MongoClient, ObjectId } from "mongodb";
import createApp from "../src/app.js";
import { env } from "../src/config/env.js";

const TEST_DB = "booknook_book_verification";

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
  createdAt: string;
  updatedAt: string;
}

interface ListEnvelope {
  status: string;
  results: number;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  books: ApiBook[];
}

const run = async (): Promise<void> => {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(TEST_DB);
  const books = db.collection("books");
  await books.deleteMany({});

  const app = createApp(db);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const getList = async (queryString = ""): Promise<{ status: number; body: ListEnvelope }> => {
    const res = await fetch(`${base}/api/books${queryString}`);
    return { status: res.status, body: (await res.json()) as ListEnvelope };
  };
  const getDetail = async (id: string): Promise<{ status: number; body: { status: string; message?: string; data?: ApiBook } }> => {
    const res = await fetch(`${base}/api/books/${id}`);
    return { status: res.status, body: (await res.json()) as { status: string; message?: string; data?: ApiBook } };
  };

  // ── 1. Empty collection ──────────────────────────────────────────────────
  console.log("\n1. Empty collection");
  {
    const { status, body } = await getList();
    check("200 on empty collection", status === 200);
    check("status success", body.status === "success");
    check("books is an empty array", Array.isArray(body.books) && body.books.length === 0);
    check("total is 0", body.total === 0);
    check("totalPages is 0", body.totalPages === 0);
  }

  // ── Seed real documents ──────────────────────────────────────────────────
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const ownerA = new ObjectId().toString();
  const seed = [
    {
      title: "The Silent Patient",
      author: "Alex Michaelides",
      category: "Fiction",
      image: "https://example.com/silent-patient.jpg",
      description: "A psychotherapist obsesses over a patient who stopped speaking.",
      addedBy: ownerA,
      addedByName: "Alice Author",
      addedByEmail: "alice@test.local",
      totalCopies: 4,
      availableCopies: 4,
      createdAt: new Date(now - 1 * hour),
      updatedAt: new Date(now - 1 * hour),
    },
    {
      title: "a brief history of time",
      author: "Stephen Hawking",
      category: "Science",
      image: "https://example.com/brief-history.jpg",
      description: "From the Big Bang to black holes.",
      addedBy: ownerA,
      addedByName: "Alice Author",
      addedByEmail: "alice@test.local",
      totalCopies: 2,
      availableCopies: 1,
      createdAt: new Date(now - 3 * hour),
      updatedAt: new Date(now - 3 * hour),
    },
    {
      title: "Clean Code",
      author: "Robert C. Martin",
      category: "Programming",
      image: "https://example.com/clean-code.jpg",
      description: "A handbook of agile software craftsmanship.",
      addedBy: ownerA,
      addedByName: "Alice Author",
      addedByEmail: "alice@test.local",
      totalCopies: 7,
      availableCopies: 7,
      createdAt: new Date(now - 2 * hour),
      updatedAt: new Date(now - 2 * hour),
    },
    {
      title: "Zebra Tales",
      author: "Zoe Zamboni",
      category: "Kids",
      image: "https://example.com/zebra-tales.jpg",
      description: "Stories about stripes.",
      addedBy: ownerA,
      addedByName: "Alice Author",
      addedByEmail: "alice@test.local",
      totalCopies: 1,
      availableCopies: 1,
      createdAt: new Date(now - 4 * hour),
      updatedAt: new Date(now - 4 * hour),
    },
  ];
  const inserted = await books.insertMany(seed);
  const silentPatientId = inserted.insertedIds[0].toString();

  // ── 2. Real documents returned with correct shape ───────────────────────
  console.log("\n2. GET /api/books returns real documents");
  {
    const { status, body } = await getList();
    check("200 with documents", status === 200 && body.books.length === 4);
    const first = body.books[0];
    check("frontend alias quantity === totalCopies", first?.quantity === first?.totalCopies, `quantity=${first?.quantity}`);
    check("frontend alias userName === addedByName", first?.userName === "Alice Author");
    check("frontend alias userEmail === addedByEmail", first?.userEmail === "alice@test.local");
    check("stable id is a 24-char hex string", /^[0-9a-f]{24}$/.test(first?.id ?? ""));
    check("total matches documents", body.total === 4);
    check("results matches returned length", body.results === 4);
    check("envelope has page/limit/totalPages", body.page === 1 && body.limit === 500 && body.totalPages === 1);
  }

  // ── 3. Newest-first default ──────────────────────────────────────────────
  console.log("\n3. Default sorting is newest first");
  {
    const { body } = await getList();
    const titles = body.books.map((b) => b.title);
    check(
      "createdAt descending by default",
      JSON.stringify(titles) === JSON.stringify([
        "The Silent Patient",
        "Clean Code",
        "a brief history of time",
        "Zebra Tales",
      ]),
      titles.join(" | ")
    );
  }

  // ── 4. sort=oldest ───────────────────────────────────────────────────────
  console.log("\n4. sort=oldest");
  {
    const { body } = await getList("?sort=oldest");
    check("createdAt ascending", body.books[0]?.title === "Zebra Tales" && body.books[3]?.title === "The Silent Patient");
  }

  // ── 5. Title sorts (case-insensitive) ────────────────────────────────────
  console.log("\n5. Title sorting");
  {
    const asc = await getList("?sort=title-asc");
    const ascTitles = asc.body.books.map((b) => b.title);
    check(
      "title-asc is case-insensitive A→Z",
      JSON.stringify(ascTitles) === JSON.stringify([
        "a brief history of time",
        "Clean Code",
        "The Silent Patient",
        "Zebra Tales",
      ]),
      ascTitles.join(" | ")
    );

    const desc = await getList("?sort=title-desc");
    const descTitles = desc.body.books.map((b) => b.title);
    check("title-desc is exact reverse of title-asc", JSON.stringify(descTitles) === JSON.stringify([...ascTitles].reverse()));
  }

  // ── 6. sort=quantity-desc ────────────────────────────────────────────────
  console.log("\n6. sort=quantity-desc");
  {
    const { body } = await getList("?sort=quantity-desc");
    check(
      "totalCopies descending",
      JSON.stringify(body.books.map((b) => b.totalCopies)) === JSON.stringify([7, 4, 2, 1]),
      body.books.map((b) => b.totalCopies).join(",")
    );
  }

  // ── 7. Unknown sort falls back ───────────────────────────────────────────
  console.log("\n7. Unknown sort value");
  {
    const { status, body } = await getList("?sort=not-a-real-sort");
    check("200 for unknown sort", status === 200);
    check("falls back to newest", body.books[0]?.title === "The Silent Patient");
  }

  // ── 8. Category filter ───────────────────────────────────────────────────
  console.log("\n8. Category filtering");
  {
    const { body } = await getList("?category=Science");
    check("only Science books", body.books.length === 1 && body.books[0]?.title === "a brief history of time");
    check("total reflects filter", body.total === 1);
  }

  // ── 9. All/empty category ────────────────────────────────────────────────
  console.log("\n9. category=All and empty category");
  {
    const all = await getList("?category=All");
    check("category=All returns everything", all.body.books.length === 4);
    const empty = await getList("?category=");
    check("empty category returns everything", empty.body.books.length === 4);
  }

  // ── 10. Search ───────────────────────────────────────────────────────────
  console.log("\n10. Search (title/author, case-insensitive)");
  {
    const byTitle = await getList("?search=CLEAN");
    check("search matches title case-insensitively", byTitle.body.books.length === 1 && byTitle.body.books[0]?.title === "Clean Code");

    const byAuthor = await getList("?search=hawking");
    check("search matches author", byAuthor.body.books.length === 1 && byAuthor.body.books[0]?.author === "Stephen Hawking");

    const noMatch = await getList("?search=quantum+computing");
    check("no-match search returns empty list", noMatch.status === 200 && noMatch.body.books.length === 0 && noMatch.body.total === 0);
  }

  // ── 11. Pagination ───────────────────────────────────────────────────────
  console.log("\n11. Pagination");
  {
    const { body } = await getList("?limit=2&page=2&sort=newest");
    check("page 2 has the remaining 2 items", body.books.length === 2, body.books.map((b) => b.title).join(" | "));
    check("page 2 starts at correct offset", body.books[0]?.title === "a brief history of time");
    check("total stays 4 across pages", body.total === 4);
    check("totalPages computed (ceil)", body.totalPages === 2);
    check("page/limit echoed", body.page === 2 && body.limit === 2);
  }

  // ── 12. limit clamping ───────────────────────────────────────────────────
  console.log("\n12. Safety clamping");
  {
    const { status, body } = await getList("?limit=99999");
    check("huge limit clamped to cap", status === 200 && body.limit === 500);
    const bad = await getList("?limit=-5");
    check("negative limit falls back to default", bad.status === 200 && bad.body.limit === 500);
    const badPage = await getList("?page=0");
    check("page=0 falls back to page 1", badPage.status === 200 && badPage.body.page === 1);
  }

  // ── 13. GET /api/books/:id valid ─────────────────────────────────────────
  console.log("\n13. GET /api/books/:id (valid)");
  {
    const { status, body } = await getDetail(silentPatientId);
    check("200 for existing book", status === 200);
    check("status success", body.status === "success");
    check("correct book returned", body.data?.title === "The Silent Patient" && body.data?.author === "Alex Michaelides");
    check("id matches requested id", body.data?.id === silentPatientId);
    check("quantity alias present", body.data?.quantity === 4);
  }

  // ── 14. Missing book (valid ObjectId) ────────────────────────────────────
  console.log("\n14. Missing book");
  {
    const { status, body } = await getDetail(new ObjectId().toString());
    check("404 for absent book", status === 404);
    check("fail shape with message", body.status === "fail" && typeof body.message === "string");
  }

  // ── 15. Malformed id ─────────────────────────────────────────────────────
  console.log("\n15. Malformed ObjectId");
  {
    const cases = ["not-an-object-id", "123", "", "%20%20", "zzzzzzzzzzzzzzzzzzzzzzzz"];
    for (const bad of cases) {
      const { status } = await getDetail(bad);
      // Empty string matches the bare /api/books route (list), which is fine;
      // every other malformed value must be a clean 400.
      if (bad === "") {
        check("bare /api/books (empty id) still serves the list", status === 200);
      } else {
        check(`400 for malformed id "${bad}"`, status === 400);
      }
    }
  }

  // ── 16. Regex metacharacters in search ───────────────────────────────────
  console.log("\n16. Regex metacharacter safety");
  {
    const { status, body } = await getList("?search=" + encodeURIComponent(".*"));
    check("metacharacters treated literally (no match)", status === 200 && body.books.length === 0);
    const paren = await getList("?search=" + encodeURIComponent("C++"));
    check("C++ search does not crash the server", paren.status === 200);
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
  console.log("📚 Phase 4 book read API verification passed.");
};

run().catch(async (error) => {
  console.error("❌ Book API verification crashed:", error);
  process.exit(1);
});
