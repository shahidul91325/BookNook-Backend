import { MongoClient, type Db } from "mongodb";
import { env } from "./env.js";

let client: MongoClient | null = null;

export const connectDB = async (): Promise<Db> => {
  if (!client) {
    client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
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
