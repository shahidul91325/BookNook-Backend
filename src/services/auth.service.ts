import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import {
  getAuthSessionsCollection,
  getAuthUsersCollection,
} from "../config/collections.js";
import { env } from "../config/env.js";
import type {
  AuthenticatedContext,
  AuthenticatedUser,
} from "../types/auth.js";

/**
 * Better Auth v1.7.14 session verification for the Express API.
 *
 * ── The verified contract (read before changing anything here) ─────────────
 *
 * The Next.js frontend runs Better Auth 1.7.14 with the `mongodbAdapter`
 * against the SAME MongoDB database this server uses. On sign-in, Better
 * Auth:
 *
 *   1. Generates an OPAQUE, high-entropy random session token
 *      (`generateId(32)`) and stores it RAW in the `session` collection
 *      together with `userId` and `expiresAt`. It is NOT a JWT.
 *   2. Sets an HMAC-SHA256 signed httpOnly cookie named
 *      `better-auth.session_token` (or `__Secure-…` over https) whose
 *      value is:  encodeURIComponent(`${token}.${base64(HMAC_SHA256(secret, token))}`)
 *      — produced by `better-call`'s `signCookieValue`, secret = the shared
 *      `BETTER_AUTH_SECRET`.
 *
 * The frontend API client sends requests with `credentials: "include"`, so
 * that signed cookie rides along to this Express server (CORS is configured
 * with `credentials: true`). A `Authorization: Bearer <token>` header is
 * also supported, mirroring Better Auth's own `bearer()` plugin behavior:
 * a dotted bearer value must carry a valid signature; a bare opaque value
 * is treated as a raw session token and must exist in the session store.
 *
 * ── Verification strategy ──────────────────────────────────────────────────
 *
 *  1. Extract the candidate token (cookie first, then Bearer header).
 *  2. If it is in signed form (`value.signature`), verify the HMAC-SHA256
 *     signature with the shared secret (constant-time compare) BEFORE the
 *     value is used for anything. Forged/tampered cookies are rejected
 *     outright. Cookies must always be signed; that is how Better Auth
 *     itself issues them.
 *  3. Look the opaque token up in the `session` collection — the database
 *     is the single source of truth (revocation-aware, expiry-aware).
 *  4. Reject expired sessions (`expiresAt` in the past).
 *  5. Load the `user` document referenced by `session.userId` and build a
 *     fully server-derived `AuthenticatedContext`.
 *
 * The client can influence NOTHING in the resulting identity: no
 * client-supplied `userId`, `email`, or ownership field is ever read.
 */

/** Cookie names issued by Better Auth 1.7.14 (secure + non-secure variants). */
const SESSION_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

/**
 * Verifies a Better Auth signed value (`token.signature`) in exactly the
 * format `better-call`'s `signCookieValue` produces:
 * standard base64 HMAC-SHA256 of the value with the shared secret.
 *
 * @returns the verified raw value, or `null` when the signature is missing,
 *          malformed, or does not match.
 */
export const verifySignedValue = (
  signedValue: string,
  secret: string
): string | null => {
  const signatureStart = signedValue.lastIndexOf(".");
  if (signatureStart <= 0 || signatureStart === signedValue.length - 1) {
    return null;
  }

  const value = signedValue.slice(0, signatureStart);
  const providedSignature = signedValue.slice(signatureStart + 1);

  const expectedSignature = createHmac("sha256", secret)
    .update(value, "utf8")
    .digest("base64");

  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  // Constant-time compare; length mismatch is safe to short-circuit because
  // the signature length is public knowledge (36 base64 chars).
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return value;
};

/** Parses a raw `Cookie` header into a name → decoded-value map. */
const parseCookieHeader = (header: string | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = pair.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
};

/** Result of extracting a candidate session token from a request. */
export type ExtractedToken =
  | { kind: "signed"; token: string }
  | { kind: "opaque"; token: string }
  | null;

/**
 * Extracts the candidate session token from the request.
 *
 * Signed cookie values MUST carry a valid HMAC signature (that is how
 * Better Auth issues them); anything else is rejected as `null`.
 * Bearer tokens may be signed (dotted) or bare opaque tokens, matching
 * Better Auth's `bearer()` plugin.
 */
export const extractSessionToken = (
  cookieHeader: string | undefined,
  authorizationHeader: string | undefined
): ExtractedToken => {
  const cookies = parseCookieHeader(cookieHeader);
  for (const name of SESSION_COOKIE_NAMES) {
    const raw = cookies.get(name);
    if (!raw || raw === "undefined" || raw === "null") continue;

    const token = verifySignedValue(raw, env.BETTER_AUTH_SECRET);
    if (token) return { kind: "signed", token };
    // A present-but-unsigned/invalid cookie is treated as no credentials
    // rather than a hard error, mirroring Better Auth's getSignedCookie.
  }

  if (authorizationHeader) {
    const scheme = authorizationHeader.slice(0, 7).toLowerCase();
    if (scheme === "bearer ") {
      const raw = authorizationHeader.slice(7).trim();
      if (raw) {
        if (raw.includes(".")) {
          // Signed form: the signature MUST verify before this token is used.
          let decoded = raw;
          try {
            decoded = decodeURIComponent(raw);
          } catch {
            /* keep raw */
          }
          const token = verifySignedValue(decoded, env.BETTER_AUTH_SECRET);
          return token ? { kind: "signed", token } : null;
        }
        // Bare opaque session token: verified by the authoritative DB lookup.
        return { kind: "opaque", token: raw };
      }
    }
  }

  return null;
};

/** Builds the public, strongly typed user view from a Better Auth user doc. */
const toAuthenticatedUser = (doc: {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticatedUser => ({
  id: doc._id.toString(),
  name: doc.name,
  email: doc.email,
  emailVerified: doc.emailVerified,
  image: doc.image ?? null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/**
 * Resolves a verified session token into an `AuthenticatedContext`.
 *
 * This is the ONLY way request identity should be established. Returns
 * `null` for unknown, revoked, or expired sessions.
 */
export const resolveAuthenticatedUser = async (
  db: Db,
  token: string
): Promise<AuthenticatedContext | null> => {
  const sessions = getAuthSessionsCollection(db);
  const users = getAuthUsersCollection(db);

  // The opaque token is looked up verbatim — the session store is the
  // single source of truth for whether a session exists and is valid.
  const session = await sessions.findOne({ token });
  if (!session) return null;

  const expiresAt =
    session.expiresAt instanceof Date
      ? session.expiresAt
      : new Date(session.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return null;
  }

  // The adapter serializes `userId` (a reference to `user.id`) to an
  // ObjectId on write; coerce any string form the same way for the lookup.
  const rawUserId = session.userId;
  let resolvedUserId: ObjectId;
  if (rawUserId instanceof ObjectId) {
    resolvedUserId = rawUserId;
  } else {
    try {
      resolvedUserId = new ObjectId(String(rawUserId));
    } catch {
      // Not a valid ObjectId — the referenced user cannot exist.
      return null;
    }
  }

  const user = await users.findOne({ _id: resolvedUserId });
  if (!user) return null;

  return {
    user: toAuthenticatedUser(user),
    session: {
      id: session._id.toString(),
      expiresAt,
    },
  };
};

/**
 * Full pipeline: extract credentials from the request, cryptographically
 * verify them, and resolve the verified identity from the session store.
 * Returns `null` when the request carries no usable credentials or when
 * verification fails for any reason.
 */
export const authenticateRequest = async (
  db: Db,
  cookieHeader: string | undefined,
  authorizationHeader: string | undefined
): Promise<AuthenticatedContext | null> => {
  const extracted = extractSessionToken(cookieHeader, authorizationHeader);
  if (!extracted) return null;
  return resolveAuthenticatedUser(db, extracted.token);
};
