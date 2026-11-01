import { ObjectId } from "mongodb";
import type { Request } from "express";

export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const isValidObjectId = (value: string): boolean => OBJECT_ID_PATTERN.test(value);

/**
 * Safely converts a string to ObjectId.
 * Returns null instead of throwing for malformed input.
 */
export const toObjectId = (value: string): ObjectId | null =>
  isValidObjectId(value) ? new ObjectId(value) : null;

/**
 * Reads the `:id` route param as a string (Express 5 params are loosely
 * typed). Pair with the `validateObjectId` middleware, which already
 * guarantees the value is a well-formed ObjectId on guarded routes.
 */
export const getRouteId = (req: Request): string =>
  typeof req.params.id === "string" ? req.params.id : "";
