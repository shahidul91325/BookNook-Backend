/**
 * Strongly typed shapes for a verified (server-side authenticated) user.
 *
 * These types describe the IDENTITY THE SERVER ITSELF resolved from a
 * cryptographically verified Better Auth JWT — never data supplied
 * by the client. See `src/services/auth.service.ts` for the verification
 * flow.
 */

/** The stable, verified authenticated user. */
export interface AuthenticatedUser {
  /** Stable Better Auth user id (string form of the user's MongoDB `_id`). */
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  /** User role — "admin" or "user". Defaults to "user". Loaded from the
   *  database after JWT subject verification, never from client input. */
  role: "admin" | "user";
  createdAt: Date;
  updatedAt: Date;
}

/** The verified JWT's subject and expiration represented as a session view. */
export interface AuthenticatedSession {
  /** MongoDB `_id` of the session document. */
  id: string;
  /** Absolute instant after which the session is no longer valid. */
  expiresAt: Date;
}

/** Attached to `req.auth` by the authentication middleware. */
export interface AuthenticatedContext {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
}

declare global {
  namespace Express {
    interface Request {
      /**
       * Present only after a successful verified authentication.
       * Always derived server-side from the verified JWT subject —
       * client-provided identity fields are never copied in here.
       */
      auth?: AuthenticatedContext;
    }
  }
}
