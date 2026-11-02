import { MongoClient, type Db } from "mongodb";
import { env } from "./env.js";

let client: MongoClient | null = null;

/** Max time (ms) to wait for the initial MongoDB connection and for each socket operation. */
const CONNECT_TIMEOUT_MS = 10_000;

export const connectDB = async (): Promise<Db> => {
  if (!client) {
    client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 10,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: CONNECT_TIMEOUT_MS,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    console.log("✅ MongoDB Atlas connected");
  }
  return client.db(env.DB_NAME);
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
