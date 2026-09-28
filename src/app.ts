import { Hono } from "hono";
import { ZodError } from "zod";

import { ApiError } from "./api/errors";
import { api } from "./api/routes";
import { validateRuntimeConfig } from "./config";
import type { Bindings } from "./types";

export const app = new Hono<{ Bindings: Bindings }>();

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
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
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
