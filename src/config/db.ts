import { MongoClient, type Db } from "mongodb";
import { env } from "./env.js";

let client: MongoClient | null = null;
/** A single in-flight connection promise that resolves to the MongoClient.
 *  Ensures concurrent connectDB() calls share one connection attempt instead
 *  of spawning duplicate clients. */
let connectionPromise: Promise<MongoClient> | null = null;

/** Max time (ms) to wait for the initial MongoDB connection and for each socket operation. */
const CONNECT_TIMEOUT_MS = 10_000;

export const connectDB = async (): Promise<Db> => {
  if (client) {
    return client.db(env.DB_NAME);
  }

  // If a connection attempt is already in progress, wait for it.
  if (connectionPromise) {
    const c = await connectionPromise;
    client = c;
    return c.db(env.DB_NAME);
  }

  // Start a new connection attempt. The `finally` block resets
  // `connectionPromise` so a failed attempt can be retried on the next call.
  const connectPromise = (async (): Promise<MongoClient> => {
    const c = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 10,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: CONNECT_TIMEOUT_MS,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    await c.connect();
    console.log("✅ MongoDB Atlas connected");
    return c;
  })();

  connectionPromise = connectPromise;

  try {
    const c = await connectPromise;
    client = c;
    connectionPromise = null;
    return c.db(env.DB_NAME);
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
};

export const closeDB = async (): Promise<void> => {
  if (client) {
    await client.close();
    client = null;
    console.log("🛑 MongoDB connection closed");
  }
};

process.on("unhandledRejection", () => {
  void closeDB();
});
