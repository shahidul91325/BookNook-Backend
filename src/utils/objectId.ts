import { ObjectId } from "mongodb";

export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const isValidObjectId = (value: string): boolean => OBJECT_ID_PATTERN.test(value);

/**
 * Safely converts a string to ObjectId.
 * Returns null instead of throwing for malformed input.
 */
export const toObjectId = (value: string): ObjectId | null =>
  isValidObjectId(value) ? new ObjectId(value) : null;
