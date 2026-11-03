/**
 * JWT access-token verification for the BookNook API.
 *
 * Better Auth v1.7.14 with the `mongodbAdapter` issues OPAQUE session tokens
 * by default (see `src/services/auth.service.ts`). It is NOT a JWT. However,
 * Better Auth can be configured to issue JWT access tokens alongside session
 * cookies. This module verifies those JWT access tokens when presented in the
 * `Authorization: Bearer <token>` header.
 *
 * No `jsonwebtoken` dependency is added — HS256 signing/verification is
 * implemented with `node:crypto`, which is sufficient because the backend
 * controls both issuance (via Better Auth) and verification.
 *
 * Verification checks:
 *   1. Signature — HMAC-SHA256 over `header.payload` with the shared secret
 *   2. Expiration — `exp` claim must be in the future
 *   3. Issuer — `iss` claim must match `JWT_ISSUER`
 *   4. Audience — `aud` claim must match `JWT_AUDIENCE`
 *
 * The client can influence NOTHING: user ID and role are extracted only from
 * the cryptographically verified JWT payload, never from headers, body, or
 * query parameters.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import {
  getAuthUsersCollection,
} from "../config/collections.js";
import { env } from "../config/env.js";
import type {
  AuthenticatedContext,
  AuthenticatedUser,
} from "../types/auth.js";
import { logError } from "../utils/logger.js";

/** Base64url encode without padding. */
const base64urlEncode = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Base64url decode, adding padding as needed. */
const base64urlDecode = (input: string): Buffer => {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  return Buffer.from(base64, "base64");
};

/** A JWT has exactly three base64url parts separated by dots. */
const JWT_PART_COUNT = 3;

export type JwtPayload = {
  /** Subject — the stable user id (string form of MongoDB `_id`). */
  sub: string;
  /** User role: "admin" or "user". */
  role: "admin" | "user";
  /** Issued-at timestamp (seconds since epoch). */
  iat: number;
  /** Expiration timestamp (seconds since epoch). */
  exp: number;
  /** Issuer. */
  iss: string;
  /** Audience. */
  aud: string | string[];
  [key: string]: unknown;
};

/**
 * Verifies a JWT access token's signature, expiration, issuer, and audience.
 *
 * @returns the decoded and verified payload, or `null` if the token is
 *          malformed, expired, or fails any check.
 */
export const verifyJwt = (
  token: string,
  secret: string,
  issuer: string,
  audience: string
): JwtPayload | null => {
  const parts = token.split(".");
  if (parts.length !== JWT_PART_COUNT) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: JwtPayload;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  // Only HS256 is supported — reject anything else to prevent algorithm
  // confusion attacks (e.g. "none" alg).
  if (header.alg !== "HS256" || header.typ !== "JWT") return null;

  // Verify signature: HMAC-SHA256(`${headerB64}.${payloadB64}`, secret)
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const providedSignature = Buffer.from(signatureB64, "utf8");
  const expectedSignatureBuf = Buffer.from(expectedSignature, "utf8");

  if (providedSignature.length !== expectedSignatureBuf.length) return null;
  if (!timingSafeEqual(providedSignature, expectedSignatureBuf)) return null;

  // Check expiration.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;

  // Check issuer.
  if (payload.iss !== issuer) return null;

  // Check audience.
  const tokenAud = payload.aud;
  const audiences = Array.isArray(tokenAud) ? tokenAud : [tokenAud];
  if (!audiences.includes(audience)) return null;

  return payload;
};

/**
 * Resolves a verified JWT payload into an `AuthenticatedContext`.
 *
 * The user is loaded from the database to confirm they still exist. The
 * role is taken from the verified JWT payload — never from the request.
 */
export const resolveAuthenticatedUserFromJWT = async (
  db: Db,
  payload: JwtPayload
): Promise<AuthenticatedContext | null> => {
  const users = getAuthUsersCollection(db);

  // `sub` is the string form of the user's MongoDB `_id`.
  let userId: ObjectId;
  try {
    userId = new ObjectId(payload.sub);
  } catch {
    return null;
  }

  const user = await users.findOne({ _id: userId });
  if (!user) return null;

  const authenticatedUser: AuthenticatedUser = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    image: user.image ?? null,
    role: payload.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  return {
    user: authenticatedUser,
    session: {
      id: `jwt:${payload.sub}:${payload.iat}`,
      expiresAt: new Date(payload.exp * 1000),
    },
  };
};
