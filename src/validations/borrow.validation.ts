import { z } from "zod";
import { MAX_BORROW_DAYS } from "../repositories/borrow.repository.js";

/**
 * Zod validation for POST /api/borrows.
 *
 * SECURITY: the schema declares ONLY `bookId` and an optional `returnDate`.
 * The frontend also sends `bookTitle`, `bookImage`, `userName`, and
 * `userEmail` — Zod strips them silently. The server takes the book's
 * title/image from the MongoDB document it fetched itself, and the
 * borrower's identity from the verified session, so none of it can be
 * spoofed through the request body.
 */

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

export const borrowBookSchema = z.object({
  bookId: z
    .string()
    .trim()
    .regex(objectIdPattern, "Invalid book id. Expected a 24-character MongoDB ObjectId."),
  /**
   * Optional requested deadline. The server still bounds it: it must be in
   * the future and no more than MAX_BORROW_DAYS away. When omitted the
   * server generates the deadline (DEFAULT_BORROW_DAYS from now).
   */
  returnDate: z.coerce
    .date("Return date must be a valid date.")
    .refine((d) => d.getTime() > Date.now(), {
      error: "Return date must be in the future.",
    })
    .refine(
      (d) => d.getTime() <= Date.now() + MAX_BORROW_DAYS * 86_400_000,
      `Return date must be within ${MAX_BORROW_DAYS} days from today.`
    )
    .optional(),
});

/** The body shape after Zod parsing/normalization. */
export type BorrowBookPayload = z.infer<typeof borrowBookSchema>;
