import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors, { type CorsOptions } from "cors";
import type { Db } from "mongodb";
import { env } from "./config/env.js";
import { createRequireAuth } from "./middleware/auth.js";

const createApp = (db: Db): Express => {
  const app = express();

  // CORS — allow only the Next.js frontend origin
  const corsOptions: CorsOptions = {
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  };
  app.use(cors(corsOptions));
  app.use(express.json());

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "success",
      message: "BookNook API is running",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Protected routes ────────────────────────────────────────────────────
  // Every private route goes through `requireAuth`, which only trusts a
  // cryptographically verified Better Auth session — never client-supplied
  // identity fields. `req.auth.user.id` is the stable verified user id.
  const requireAuth = createRequireAuth(db);

  // Returns the identity the SERVER verified for the caller. The client
  // cannot influence any field of this response.
  app.get("/api/auth/me", requireAuth, (req: Request, res: Response) => {
    res.status(200).json({
      status: "success",
      data: req.auth?.user,
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      status: "fail",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    });
  });

  // Centralized error handler (must come after routes)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({
      status: "error",
      message: "Something went wrong on the server",
    });
  });

  return app;
};

export default createApp;
