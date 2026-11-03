import type { ClientSession, Db } from "mongodb";

/**
 * Runs `work` inside a MongoDB transaction when the deployment topology
 * supports one (replica set / mongos), and falls back to running `fallback`
 * — a reliable atomic-strategy version of the same operation — on a
 * standalone mongod, where transactions are rejected.
 *
 * Detection is based on the server's own error: a standalone reports
 * error code 20 (IllegalOperation) with a "Transaction numbers are only
 * allowed on a replica set member or mongos" message on the first
 * transactional operation.
 *
 * Client-visible domain outcomes (e.g. "no copies available") are thrown
 * as `OperationError` from `src/utils/errors.ts`; the centralized error
 * handler turns them into the matching HTTP response.
 */

const isTransactionUnsupported = (error: unknown): boolean => {
  const err = error as { code?: number; message?: string };
  if (err?.code === 20) return true; // IllegalOperation — standalone mongod
  const message = err?.message ?? "";
  return (
    message.includes("Transaction numbers are only allowed") ||
    message.includes("does not support transactions") ||
    message.includes("does not support retryable writes")
  );
};

/**
 * Transaction-first executor with a topology-safe fallback.
 *
 * `work(session)` performs the multi-document operation using a session so
 * every command participates in the transaction. `fallback()` performs the
 * same logic with the atomic, non-transactional strategy (conditional
 * updates + compensation). Both must be idempotent with respect to the
 * final domain outcome.
 */
export const runWithTransactionOrFallback = async <T>(
  db: Db,
  work: (session: ClientSession) => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> => {
  const session = db.client.startSession();
  try {
    let result: T | undefined;
    let completed = false;
    let unsupported = false;

    try {
      await session.withTransaction(async () => {
        result = await work(session);
        completed = true;
      });
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      unsupported = true;
    }

    if (unsupported) return await fallback();
    if (!completed) {
      throw new Error("Transaction finished without completing its work.");
    }
    return result as T;
  } finally {
    await session.endSession();
  }
};
