/**
 * Safely converts unknown input to a valid Date.
 * Returns null for missing or invalid values instead of throwing.
 */
export const toSafeDate = (value: Date | string | number | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
