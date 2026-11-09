import type { ErrorRequestHandler } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { audit } from "../services/audit.service.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let message = "Internal server error";
  let details: unknown;

  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      status = 409;
      message = "A record with these values already exists";
    } else if (err.code === "P2025") {
      status = 404;
      message = "Record not found";
    }
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    message = "Request body is not valid JSON";
  }

  if (status >= 500) logger.error({ err, requestId: req.requestId }, "Unhandled error");

  audit({
    type: "ERROR",
    userId: req.user?.id,
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode: status,
    message: (err as Error)?.message ?? message,
    metadata: status >= 500 ? { stack: (err as Error)?.stack } : { details },
  });

  res.status(status).json({ error: message, details, requestId: req.requestId });
};
