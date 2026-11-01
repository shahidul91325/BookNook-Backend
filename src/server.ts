import createApp from "./app.js";
import { connectDB, closeDB } from "./config/db.js";
import { env } from "./config/env.js";

const startServer = async (): Promise<void> => {
  try {
    await connectDB();

    const app = createApp();

    const server = app.listen(env.PORT, () => {
      console.log(
        `🚀 Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`
      );
    });

    const shutdown = (signal: string) => {
      console.log(`${signal} received. Shutting down...`);
      server.close(() => {
        void closeDB().finally(() => process.exit(0));
      });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ Failed to start server: ${message}`);
    await closeDB();
    process.exit(1);
  }
};

void startServer();
