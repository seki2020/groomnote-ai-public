import { Hono } from "hono";
import { ZodError } from "zod";

import { ApiError, apiErrorStatus } from "./api/errors";
import { hackathonMode } from "./security/usage";
import { api } from "./api/routes";
import { validateRuntimeConfig } from "./config";
import type { Bindings } from "./types";
import { MAX_API_REQUEST_BYTES } from "./security/request";

export const app = new Hono<{ Bindings: Bindings }>();

app.use("/v1/*", async (context, next) => {
  const contentLength = Number(context.req.header("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_API_REQUEST_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }

  const origin = context.req.header("Origin");
  if (origin) {
    if (!context.env.CORS_ALLOWED_ORIGIN || origin !== context.env.CORS_ALLOWED_ORIGIN) {
      throw new ApiError(403, "ORIGIN_FORBIDDEN", "This browser origin is not allowed.");
    }
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Vary", "Origin");
    if (context.req.method === "OPTIONS") {
      context.header("Access-Control-Allow-Methods", "GET, POST");
      context.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      context.header("Access-Control-Max-Age", "600");
      return context.body(null, 204);
    }
  }
  await next();
});

app.route("/v1", api);

app.get("/health", (context) => {
  const config = validateRuntimeConfig(context.env);
  return context.json({
    status: "ok" as const,
    service: "groomnote-ai" as const,
    environment: config.APP_ENV,
  });
});

app.notFound((context) =>
  context.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    },
    404,
  ),
);

app.onError((error, context) => {
  if (error instanceof ApiError) {
    return context.json({ error: { code: error.code, message: error.message } }, apiErrorStatus(error, hackathonMode(context.env)));
  }
  if (error instanceof ZodError) {
    return context.json(
      {
        error: {
          code: "CONFIGURATION_ERROR",
          message: "The Worker runtime configuration is invalid.",
        },
      },
      500,
    );
  }

  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    },
    500,
  );
});
