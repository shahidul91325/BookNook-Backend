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

/** The body shape after Zod parsing/normalization. */
export type CreateBookPayload = z.infer<typeof createBookSchema>;

/** Groups Zod issues into a `field → messages[]` map for the 400 response. */
export const formatZodIssues = (
  error: z.ZodError
): Record<string, string[]> => {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
};
