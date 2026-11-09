import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { audit } from "../services/audit.service.js";

/**
 * Gives every request an ID and writes HTTP_REQUEST / HTTP_RESPONSE rows to audit_logs.
 * Request bodies are redacted by audit() before saving.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
  req.valid = {};
  res.setHeader("x-request-id", req.requestId);
  const started = Date.now();

  audit({
    type: "HTTP_REQUEST",
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    metadata: { body: req.body, ip: req.ip, userAgent: req.header("user-agent") },
  });

  res.on("finish", () => {
    audit({
      type: "HTTP_RESPONSE",
      userId: req.user?.id,
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  next();
};
