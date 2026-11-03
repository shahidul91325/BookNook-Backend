import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ObjectId, type Db } from "mongodb";
import { getAuthUsersCollection } from "../config/collections.js";
import { env } from "../config/env.js";
import type { AuthenticatedContext, AuthenticatedUser } from "../types/auth.js";

/** Public keys published by the same Better Auth JWT plugin that signs tokens. */
let jwksUrl: string | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet>;

const getJwks = () => {
  const url = process.env.JWT_JWKS_URL ?? env.JWT_JWKS_URL;
  if (url !== jwksUrl) {
    jwksUrl = url;
    jwks = createRemoteJWKSet(new URL(url));
  }
  return jwks;
};

export type VerifiedJwtPayload = JWTPayload & { sub: string };

/** Verify signature, key ID, issuer, audience, expiry, and standard JWT claims. */
export const verifyJwt = async (
  token: string
): Promise<VerifiedJwtPayload | null> => {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return payload as VerifiedJwtPayload;
  } catch {
    return null;
  }
};

/** Resolve the verified Better Auth subject to the current database user. */
export const resolveAuthenticatedUserFromJWT = async (
  db: Db,
  payload: VerifiedJwtPayload
): Promise<AuthenticatedContext | null> => {
  let userId: ObjectId;
  try {
    userId = new ObjectId(payload.sub);
  } catch {
    return null;
  }

  const user = await getAuthUsersCollection(db).findOne({ _id: userId });
  if (!user) return null;

  const role = user.role === "admin" ? "admin" : "user";
  const authenticatedUser: AuthenticatedUser = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    image: user.image ?? null,
    role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  return {
    user: authenticatedUser,
    session: {
      id: `jwt:${payload.sub}:${payload.iat ?? 0}`,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    },
  };
};
