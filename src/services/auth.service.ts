import type { Db } from "mongodb";
import type { AuthenticatedContext } from "../types/auth.js";
import { resolveAuthenticatedUserFromJWT, verifyJwt } from "./jwt.service.js";

/** Protected REST APIs accept only a JWT issued by the Better Auth plugin. */
export const authenticateRequest = async (
  db: Db,
  authorizationHeader: string | undefined
): Promise<AuthenticatedContext | null> => {
  if (!authorizationHeader || !/^Bearer\s+/i.test(authorizationHeader)) {
    return null;
  }

  const token = authorizationHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const payload = await verifyJwt(token);
  if (!payload) return null;
  return resolveAuthenticatedUserFromJWT(db, payload);
};
