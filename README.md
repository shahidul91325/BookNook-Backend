# BookNook Backend

Express.js + MongoDB REST API for the BookNook library application. Handles book catalog management, borrowing/returning, and user-specific book & borrow lists with Better Auth session authentication.

**Frontend:** [BookNook-Web](https://github.com/shahidul91325/BookNook-Web) (Next.js)
**API Base URL:** `http://localhost:5000` (development) — set via `NEXT_PUBLIC_API_URL` on the frontend.

---

## Features

- **Books catalog** — public listing with category filter, search, sort, and pagination
- **Book details** — public read of a single book by ID
- **Add book** — authenticated users add books; ownership recorded server-side from the verified session
- **Edit / delete book** — only the book's owner (verified session user) may modify or remove it
- **My Books** — authenticated user's own book list
- **Borrow book** — reserve a copy atomically; prevents duplicate active borrows per user per book
- **My Borrows** — authenticated user's borrow history only
- **Return book** — mark a borrow as returned and restore the copy exactly once
- **Better Auth authentication** — session cookie + bearer token verification; HMAC-signed, revocation-aware
- **Protected routes** — all write routes and user-specific reads require a verified session (401/403 otherwise)
- **Inventory consistency** — conditional copy reservation/restore, transactional with fallback for standalone MongoDB
- **Rate limiting** — global and stricter write-endpoint buckets per client IP
- **CORS hardening** — exact-origin allowlist only; no wildcards; credentials enabled
- **Standard error envelopes** — `{status, message[, errors]}`; no stack traces or driver internals leaked to clients

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES modules) |
| Framework | Express 5 |
| Language | TypeScript (strict) |
| Database | MongoDB (Atlas / local) |
| ODM | Native MongoDB driver |
| Validation | Zod 4 |
| Authentication | Better Auth (session-based, mongodbAdapter) |
| Build | `tsc` |
| Dev server | `tsx watch` |
| Testing | Custom HTTP integration scripts (`tsx`) |

---

## Folder Structure

```
BookNook-Server/
├── .env                  # Local secrets (gitignored — never commit)
├── .env.example          # Template for .env (committed)
├── .gitignore
├── package.json
├── package-lock.json
├── server.ts             # Vercel native Express entry point (default export)
├── tsconfig.json
├── README.md
├── dist/                 # Compiled output (gitignored)
├── scripts/              # Verification scripts (not runtime code)
│   ├── verify-auth.ts
│   ├── verify-books.ts
│   ├── verify-borrow.ts
│   ├── verify-create-book.ts
│   ├── verify-data-models.ts
│   ├── verify-integration.ts
│   ├── verify-manage-book.ts
│   └── verify-security.ts
└── src/
    ├── app.ts            # Express app factory + route registration
    ├── server.ts         # Entry point: connects DB, ensures indexes, listens
    ├── config/
    │   ├── db.ts         # MongoDB connection
    │   ├── env.ts        # Validated environment config
    │   ├── collections.ts # Collection accessors
    │   └── indexes.ts    # Index creation
    ├── controllers/
    │   ├── book.controller.ts
    │   └── borrow.controller.ts
    ├── middleware/
    │   ├── auth.ts       # Better Auth session verification (createRequireAuth)
    │   ├── errorHandler.ts # Centralized error envelope
    │   ├── rateLimit.ts  # Per-IP rate limiting
    │   └── validate.ts   # Zod body + ObjectId validation
    ├── models/
    │   ├── book.model.ts
    │   ├── borrow.model.ts
    │   └── auth.model.ts
    ├── repositories/
    │   ├── book.repository.ts
    │   └── borrow.repository.ts
    ├── services/
    │   └── auth.service.ts
    ├── types/
    │   └── auth.ts
    └── utils/
        ├── date.ts
        ├── errors.ts
        ├── escapeRegex.ts
        ├── httpResponse.ts
        ├── logger.ts     # Secret-scrubbed logging
        ├── objectId.ts
        └── transaction.ts
```

---

## Installation

```bash
# Clone the repository
git clone https://github.com/shahidul91325/BookNook-Backend.git
cd BookNook-Backend

# Install dependencies
npm install

# Copy the environment template and fill in real values
cp .env.example .env
# Edit .env with your MongoDB URI, Better Auth secret, CORS origin, etc.
```

### Required environment variables

| Variable | Description | Example |
|---|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` | `development` |
| `PORT` | Server port | `5000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/booknook` |
| `DB_NAME` | Database name (shared with frontend Better Auth) | `booknook` |
| `CORS_ORIGIN` | Comma-separated exact frontend origins | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | HMAC secret, byte-identical to frontend `.env.local` (min 32 chars) | `...` |
| `FRONTEND_URL` | Fallback CORS origin | `http://localhost:3000` |
| `BETTER_AUTH_URL` | Better Auth base URL | `http://localhost:3000` |

Optional: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WRITE_MAX`, `TRUST_PROXY` (defaults apply).

**Important:** `BETTER_AUTH_SECRET` must match the frontend's Next.js `.env.local` exactly, or all authenticated requests fail with 401. `.env` is gitignored — never commit real values.

---

## Development Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server with `tsx watch` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server (`node dist/server.js`) |
| `npm run verify` | Full verification: build + all test suites |
| `npm run verify:models` | Data model verification |
| `npm run verify:auth` | Better Auth verification |
| `npm run verify:books` | Book read API verification |
| `npm run verify:create` | Book creation verification |
| `npm run verify:manage` | Book update/delete verification |
| `npm run verify:borrows` | Borrow/return verification |
| `npm run verify:security` | Security & error-handling verification |
| `npm run verify:integration` | Full frontend↔backend integration verification |

---

## Build and Start

```bash
# Development
npm run dev

# Production build + start
npm run build
npm start
```

---

## API Endpoints

Base URL: `http://localhost:5000` (set `NEXT_PUBLIC_API_URL` on the frontend)

All write endpoints and user-specific reads require a valid Better Auth session (cookie or `Authorization: Bearer <token>`).

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | No | Health check |
| `GET` | `/api/books` | No | List books (category, search, sort, page, limit) |
| `GET` | `/api/books/:id` | No | Get a single book by ID |
| `POST` | `/api/books` | Yes | Create a book (body: `title`, `author`, `category`, `image`, `quantity`, `description`, `rating?`) |
| `PATCH` | `/api/books/:id` | Yes | Partial update a book you own (PUT alias also accepted) |
| `DELETE` | `/api/books/:id` | Yes | Delete a book you own (409 if active borrows exist) |
| `POST` | `/api/borrows` | Yes | Borrow a book (body: `bookId`, `returnDate?`) |
| `GET` | `/api/borrows` | Yes | List your borrow records only |
| `DELETE` | `/api/borrows/:id` | Yes | Return a borrowed book (PUT/PATCH `/:id/return` aliases also accepted) |
| `GET` | `/api/auth/me` | Yes | Return the verified caller's identity |
| `GET` | `/api/my-books` | Yes | Alias for your own books (`/api/books/my`, `/api/books/user` also accepted) |
| `GET` | `/api/my-borrows` | Yes | Alias for your borrows (`/api/borrows/my`, `/api/borrows/user` also accepted) |

### Response envelopes

**Success:** `{ "status": "success", ...payload }`

**Failure (4xx):** `{ "status": "fail", "message": "…", "errors?: {...} }`

**Error (5xx):** `{ "status": "error", "message": "Something went wrong on the server." }`

---

## Authentication

The backend does **not** issue sessions — it verifies sessions created by the Next.js frontend running Better Auth 1.7.14 with the `mongodbAdapter` against the **same MongoDB database**.

1. Better Auth issues an opaque, high-entropy session token stored in the `session` collection.
2. The client receives an HMAC-SHA256-signed `better-auth.session_token` cookie (or `__Secure-…` over HTTPS).
3. The frontend sends requests with `credentials: "include"`, so the signed cookie rides along to this API (CORS is `credentials: true`).
4. This Express server:
   - Extracts the token from the cookie or `Authorization: Bearer` header
   - Cryptographically verifies the HMAC signature with the shared `BETTER_AUTH_SECRET`
   - Looks the token up in the `session` collection (single source of truth — revocation-aware, expiry-aware)
   - Loads the referenced user and attaches a server-derived `AuthenticatedContext` to `req.auth`
5. Client-supplied identity fields (`userId`, `email`, `addedBy`, etc.) in body/query/headers are **never** trusted as identity.

`BETTER_AUTH_SECRET` must be byte-identical between backend `.env` and frontend `.env.local`.

---

---

## Deployment (Vercel)

This backend is configured for **Vercel native Express deployment**. There is no `vercel.json`, no `dist/server.js` dependency, and no TypeScript compilation step required for deployment.

### Architecture

- **`server.ts`** (root) — Vercel entry point. Creates the Express app and exports it as the default export. Never calls `app.listen()` — Vercel handles request invocation.
- **`src/app.ts`** — Express app factory (`createApp(db)`), shared by all entry points. Never calls `app.listen()`.
- **`src/server.ts`** — Local development entry point. Imports `createApp`, connects MongoDB, and calls `app.listen()`. Used by `npm run dev` only.

### How Vercel deploys this

1. Vercel detects the default Express export from root `server.ts`.
2. Vercel wraps it in a serverless function automatically (native Express support).
3. No `vercel.json` is needed — no rewrites, no custom output directory, no build override.
4. Install command: `npm ci` (automatic package-manager detection).
5. Build command: Default / none required.

### Required steps

1. **Connect the repo** to Vercel as a project (Import → select `BookNook-Backend`).
2. **Root Directory:** Backend project root (where `package.json` and `server.ts` live).
3. **Framework:** Express — Vercel detects it automatically.
4. **Build Command:** Leave default (no override needed).
5. **Output Directory:** Leave default (no override needed).
6. **Install Command:** Leave default (`npm ci` is detected automatically).
7. **Set environment variables** in the Vercel project dashboard (do **not** commit `.env`):

| Variable | Description | Required |
|---|---|---|
| `NODE_ENV` | `production` | Yes |
| `PORT` | Any value (ignored by serverless runtime, but `env.ts` requires it) | Yes |
| `MONGODB_URI` | MongoDB Atlas connection string | Yes |
| `DB_NAME` | Database name (shared with frontend Better Auth) | Yes |
| `CORS_ORIGIN` | Production frontend URL (exact origin, no wildcard) | Yes |
| `BETTER_AUTH_SECRET` | HMAC secret, byte-identical to frontend `.env.local` (min 32 chars) | Yes |
| `FRONTEND_URL` | Fallback CORS origin | No |
| `BETTER_AUTH_URL` | Better Auth base URL | No |

### Critical Vercel settings

- **MongoDB Atlas IP whitelist:** Add Vercel's outbound IP ranges to your Atlas cluster's Network Access list, or serverless function connections will fail.
- **`CORS_ORIGIN`:** Must be your production frontend URL (e.g. `https://booknook.vercel.app`). Wildcards are rejected because credentials are enabled.
- **`BETTER_AUTH_SECRET`:** Must match the frontend's Next.js `.env.local` exactly, or all authenticated requests fail with 401.

### Local development

```bash
# Start local dev server (listens on localhost:5000)
npm run dev

# Type-check (no emit)
npx tsc --noEmit

# Production build (generates dist/ for local testing only)
npm run build

# Run compiled server locally
npm start
```

> **Note:** Test `GET /`, `GET /api/health`, and `GET /api/testimonials` first — these respond even if MongoDB is temporarily unavailable.

---

## Security

- CORS allowlist: exact origins only; wildcards rejected at startup
- Credentials enabled only for listed origins
- Rate limiting: global + stricter write buckets per client IP
- No secrets in responses; stack traces and driver errors are logged server-side only
- `BETTER_AUTH_SECRET` and `MONGODB_URI` are never logged or echoed
- Ownership enforced server-side from verified session; query-level guards on every write
- Partial unique index prevents duplicate active borrows per user per book

---

## License

ISC