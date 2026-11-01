import { z } from "zod";

/**
 * Zod validation for the book write APIs.
 *
 * The category list is kept byte-identical to the frontend's
 * `CATEGORIES` constant in `components/books/add-book-form.tsx` —
 * a book with any other category would render as an unknown filter
 * option in the catalog.
 */

export const BOOK_CATEGORIES = [
  "Fiction",
  "Science",
  "History",
  "Kids",
  "Self Help",
  "Programming",
  "Fantasy",
  "Financial",
  "Others",
] as const;

/**
 * Same rule the frontend enforces: an absolute http(s) URL or an
 * internally uploaded asset path.
 */
const IMAGE_PATTERN = /^(https?:\/\/.+|\/uploads\/.+)/i;

/**
 * Body schema for POST /api/books.
 *
 * SECURITY: this schema deliberately does NOT declare `addedBy`,
 * `addedByName`, `addedByEmail`, `userName`, `userEmail`, `createdAt`,
 * `updatedAt`, `id`, or `_id`. Zod strips unknown keys by default, so any
 * ownership/identity fields a client sends are silently DISCARDED —
 * ownership is always taken from the verified session (Phase 3
 * middleware), never from the request body.
 *
 * `quantity` is the frontend-compatible alias for `totalCopies`.
 */
export const createBookSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Title must be at least 2 characters.")
    .max(200, "Title must be at most 200 characters."),
  author: z
    .string()
    .trim()
    .min(2, "Author must be at least 2 characters.")
    .max(120, "Author must be at most 120 characters."),
  category: z.enum(BOOK_CATEGORIES, {
    error: "Category must be one of the allowed BookNook categories.",
  }),
  image: z
    .string()
    .trim()
    .min(1, "Book cover image is required.")
    .regex(IMAGE_PATTERN, "Image must be an HTTP/HTTPS URL or an /uploads/ path."),
  description: z
    .string()
    .trim()
    .min(10, "Description must be at least 10 characters.")
    .max(2000, "Description must be at most 2000 characters."),
  /** Frontend alias for `totalCopies`; defaults to 1 copy. */
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number of copies.")
    .min(1, "Quantity must be at least 1 copy.")
    .max(1000, "Quantity must be at most 1000 copies.")
    .default(1),
  /** Optional star rating shown on the details page. */
  rating: z.coerce
    .number()
    .min(0, "Rating must be between 0 and 5.")
    .max(5, "Rating must be between 0 and 5.")
    .optional(),
});

/**
 * Body schema for PATCH/PUT /api/books/:id — every field is OPTIONAL so
 * omitted fields are simply preserved (only provided fields are $set).
 *
 * SECURITY: like the create schema, it declares NO ownership fields
 * (`addedBy`, `addedByName`, `addedByEmail`, `userName`, `userEmail`) and
 * no server-managed fields (`createdAt`, `updatedAt`, `availableCopies`,
 * `id`, `_id`) — Zod strips them, so ownership can never be transferred
 * through an update request.
 *
 * `quantity` may be 0 here (the frontend edit dialog allows setting a book
 * to zero copies) — unlike creation, which requires at least 1.
 */
export const updateBookSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters.")
      .max(200, "Title must be at most 200 characters.")
      .optional(),
    author: z
      .string()
      .trim()
      .min(2, "Author must be at least 2 characters.")
      .max(120, "Author must be at most 120 characters.")
      .optional(),
    category: z
      .enum(BOOK_CATEGORIES, {
        error: "Category must be one of the allowed BookNook categories.",
      })
      .optional(),
    image: z
      .string()
      .trim()
      .min(1, "Book cover image is required.")
      .regex(IMAGE_PATTERN, "Image must be an HTTP/HTTPS URL or an /uploads/ path.")
      .optional(),
    description: z
      .string()
      .trim()
      .min(10, "Description must be at least 10 characters.")
      .max(2000, "Description must be at most 2000 characters.")
      .optional(),
    /** Frontend alias for `totalCopies`; 0 is allowed (book fully checked out). */
    quantity: z.coerce
      .number()
      .int("Quantity must be a whole number of copies.")
      .min(0, "Quantity must be 0 or greater.")
      .max(1000, "Quantity must be at most 1000 copies.")
      .optional(),
    rating: z.coerce
      .number()
      .min(0, "Rating must be between 0 and 5.")
      .max(5, "Rating must be between 0 and 5.")
      .optional(),
  })
  .refine((payload) => Object.values(payload).some((v) => v !== undefined), {
    error: "Provide at least one field to update.",
  });

/** The body shape after Zod parsing/normalization. */
export type CreateBookPayload = z.infer<typeof createBookSchema>;
export type UpdateBookPayload = z.infer<typeof updateBookSchema>;

/**
 * Query schema for GET /api/books.
 *
 * The catalog endpoint is deliberately LENIENT: the frontend paginates
 * client-side and sometimes omits every parameter, and invalid values fall
 * back to safe defaults instead of failing the request (this behavior is
 * part of the established API contract — see scripts/verify-books.ts).
 *
 * Zod `.catch()` makes the parse total: any malformed value (array, object,
 * negative number, unknown sort, missing key) resolves to the documented
 * default, so the database can never receive an unbounded or malformed
 * filter/sort/skip.
 */

/** Safety cap for a single page, protecting the database from unbounded scans. */
export const MAX_BOOK_PAGE_SIZE = 500;

/** Sort modes accepted from the frontend; anything else falls back to newest. */
export const BOOK_SORT_MODES = [
  "newest",
  "oldest",
  "title-asc",
  "title-desc",
  "quantity-desc",
] as const;

/**
 * Query-string values arrive as a string, an array (repeated key), or an
 * object (key[]=…). Anything that is not a plain string is treated as
 * absent so the schema's default applies — exactly the lenient behavior
 * the endpoint has always had.
 */
const singleValue = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" ? value : undefined), schema);

export const listBooksQuerySchema = z.object({
  category: singleValue(z.string().trim().catch("")),
  search: singleValue(z.string().trim().catch("")),
  limit: singleValue(
    z.coerce.number().int().min(1).max(MAX_BOOK_PAGE_SIZE).catch(MAX_BOOK_PAGE_SIZE)
  ),
  page: singleValue(z.coerce.number().int().min(1).catch(1)),
  sort: singleValue(z.enum(BOOK_SORT_MODES).catch("newest")),
});

/** The query shape after Zod parsing/normalization. */
export type ListBooksQuery = z.infer<typeof listBooksQuerySchema>;
