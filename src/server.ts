import createApp from "./app.js";
import { connectDB, closeDB } from "./config/db.js";
import { ensureIndexes } from "./config/indexes.js";
import { env } from "./config/env.js";
import { logError, logInfo } from "./utils/logger.js";

const startServer = async (): Promise<void> => {
  try {
    const db = await connectDB();
    await ensureIndexes(db);

    const app = createApp(db);

    const server = app.listen(env.PORT, () => {
      logInfo(`🚀 Server listening on port ${env.PORT} (${env.NODE_ENV})`);
    });

    const shutdown = (signal: string) => {
      logInfo(`${signal} received. Shutting down...`);
      server.close(() => {
        void closeDB().finally(() => process.exit(0));
      });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    // Startup failures can embed connection strings — log through the
    // scrubber so credentials never end up in log files.
    logError("startup", error);
    await closeDB();
    process.exit(1);
  }
};

void startServer();
