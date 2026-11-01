import type { ObjectId } from "mongodb";

/**
 * A user document as stored by Better Auth (v1.7.14) in the `user`
 * collection of the shared `booknook` database.
 *
 * `_id` is a MongoDB ObjectId whose string form is the stable public
 * user id returned by Better Auth (`user.id`) and used by the frontend.
 */
export type BetterAuthUser = {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A session document as stored by Better Auth (v1.7.14) in the `session`
 * collection.
 *
 * `token` is an opaque, high-entropy random string (NOT a JWT). The client
 * holds it inside an HMAC-signed cookie; the database copy is the single
 * source of truth for session validity.
 */
export type BetterAuthSession = {
  _id: ObjectId;
  token: string;
  /** References `user._id`. Stored as ObjectId or its string form depending on adapter path. */
  userId: ObjectId | string;
  /** Session is invalid once this instant passes. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string;
  userAgent?: string;
};
