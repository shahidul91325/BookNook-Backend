import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { jwt } from "better-auth/plugins";
import type { Db } from "mongodb";
import { env } from "./config/env.js";

/** The single Better Auth instance, hosted by Express. */
export const createAuth = (db: Db) =>
  betterAuth({
    database: mongodbAdapter(db),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.CORS_ORIGINS,
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false,
        },
      },
    },
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          },
        }
      : {}),
    plugins: [
      jwt({
        jwt: {
          issuer: env.BETTER_AUTH_URL,
          audience: env.BETTER_AUTH_URL,
          expirationTime: "15m",
        },
      }),
    ],
  });
