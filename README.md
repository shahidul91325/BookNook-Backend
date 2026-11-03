# BookNook Backend

Express.js + MongoDB API for BookNook. Express hosts Better Auth and the REST API, including book management and borrowing.

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
- **Better Auth authentication** — cookie-backed sessions, JWT plugin, and JWKS-based REST verification
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
| Authentication | Better Auth (Express server, MongoDB adapter, JWT/JWKS plugin) |
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
    │   ├── auth.ts       # Better Auth JWT verification (createRequireAuth)
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
| `MONGODB_URI` | MongoDB connection string; standalone local Mongo must include `retryWrites=false` | URI with credentials |
| `MONGODB_DB_NAME` | MongoDB database used by Express, including Better Auth collections | `booknook` |
| `CORS_ORIGIN` | Comma-separated exact frontend origins; preferred over legacy `FRONTEND_URL` | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | Express Better Auth secret (min 32 chars; server-only) | `<secret>` |
| `BETTER_AUTH_URL` | Frontend origin plus `/api/auth` base path used by the JWT issuer | `http://localhost:3000/api/auth` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID for the frontend callback (optional) | `<client-id>` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (optional) | `<client-secret>` |
| `JWT_ISSUER` | JWT issuer; defaults to `BETTER_AUTH_URL` | `http://localhost:3000/api/auth` |
| `JWT_AUDIENCE` | JWT audience; defaults to `BETTER_AUTH_URL` | `http://localhost:3000/api/auth` |
| `JWT_JWKS_URL` | Direct Express JWT plugin JWKS endpoint; defaults to `BETTER_AUTH_URL/jwks` | `http://localhost:5000/api/auth/jwks` |

Optional: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WRITE_MAX`, `TRUST_PROXY` (defaults apply).

`.env` is gitignored — never commit real values. The frontend does not receive the Better Auth secret, Google client secret, or MongoDB credentials.

---

## Development Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server with `tsx watch` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server (`node dist/server.js`) |
| `npm run verify` | Full verification: build + all test suites |
| `npm run verify:models` | Data model verification |
| `npm run verify:books` | Public book catalog and details API verification |
| `npm run verify:auth` | Better Auth verification |
| `npm run verify:integration` | Authenticated add/edit/delete, owner isolation, borrow/return, and inventory verification |
| `npm run verify:security` | CORS, validation, rate limiting, ownership, error handling, and leak checks |
| `npm run verify:create`, `verify:manage`, `verify:borrows` | Compatibility aliases for the integration suite |

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

All write endpoints and user-specific reads require a valid Better Auth JWT in `Authorization: Bearer <token>`.

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
| `GET` | `/api/my-books` | Yes | Alias for your own books (`/api/books/my`, `/api/books/user` also accepted) |
| `GET` | `/api/my-borrows` | Yes | Alias for your borrows (`/api/borrows/my`, `/api/borrows/user` also accepted) |

### Response envelopes

**Success:** `{ "status": "success", ...payload }`

**Failure (4xx):** `{ "status": "fail", "message": "…", "errors?: {...} }`

**Error (5xx):** `{ "status": "error", "message": "Something went wrong on the server." }`

---

## Authentication

Express hosts the sole Better Auth instance at `/api/auth`, backed by its MongoDB adapter. Next.js forwards the frontend-origin `/api/auth/*` path to this Express handler, so the browser keeps the server-issued httpOnly session cookie on the frontend host. Email/password and Google OAuth are configured by this server.

The frontend obtains access tokens from the official JWT plugin `GET /api/auth/token` endpoint. The plugin signs JWTs with its managed asymmetric key pair and publishes public keys at `/api/auth/jwks`. Protected REST requests send `Authorization: Bearer <JWT>`; Express verifies signature via that JWKS plus `exp`, issuer, and audience, then loads the subject user from MongoDB. Client-supplied IDs, emails, and roles never establish identity. `BETTER_AUTH_SECRET` stays server-only and is not reused as a JWT signing secret. There is no separate `JWT_SECRET`: the verifier trusts the Better Auth JWKS, and a `JWT_SECRET` variable has no effect.

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
| `NODE_ENV` | `production` (provided by Vercel) | No |
| `PORT` | Local listener port; unused by Vercel's serverless runtime | No |
| `MONGODB_URI` | MongoDB Atlas connection string | Yes |
| `MONGODB_DB_NAME` | Database used by Express and its Better Auth adapter | Yes |
| `CORS_ORIGIN` | Production frontend URL (exact origin, no wildcard) | Yes |
| `BETTER_AUTH_SECRET` | Express Better Auth secret (min 32 chars) | Yes |
| `BETTER_AUTH_URL` | Frontend origin plus `/api/auth` | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes for Google login |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes for Google login |
| `JWT_ISSUER` | JWT issuer; defaults to `BETTER_AUTH_URL` | No |
| `JWT_AUDIENCE` | JWT audience; defaults to `BETTER_AUTH_URL` | No |
| `JWT_JWKS_URL` | Direct Express `/api/auth/jwks` endpoint | Recommended |

### Critical Vercel settings

- **MongoDB Atlas IP whitelist:** Add Vercel's outbound IP ranges to your Atlas cluster's Network Access list, or serverless function connections will fail.
- **`CORS_ORIGIN`:** For each Vercel environment, list the exact corresponding frontend origin(s), including the stable Preview origin when used.
- **`JWT_JWKS_URL`:** Set to the direct backend deployment URL plus `/api/auth/jwks`; this avoids routing backend key lookups through the frontend rewrite.
- **`BETTER_AUTH_URL`:** Set to the public frontend origin plus `/api/auth`; it must match the JWT issuer and audience defaults and the Google callback origin.
- **Google OAuth:** Register `<frontend-origin>/api/auth/callback/google` for both the production domain and the stable Preview domain if Google login is enabled.

Production and Preview are configured independently in Vercel. Use a stable
frontend Preview domain so the backend Preview `CORS_ORIGIN`, `BETTER_AUTH_URL`,
and Google callback registration can match it. If generated preview URLs are
used, those settings must be updated for each active URL. `DB_NAME` remains an
accepted legacy alias for `MONGODB_DB_NAME`; do not set both.

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
