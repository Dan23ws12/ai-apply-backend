import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { redact, redactUrl } from "../lib/redact.js";
import type { AuditLogType } from "../generated/prisma/enums.js";

export interface AuditEntry {
  type: AuditLogType;
  userId?: string | null;
  requestId?: string | null;
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  message?: string;
  metadata?: unknown;
}

/**
 * Writes one row to audit_logs. Never throws: logging must not break a request.
 * Secrets are redacted first.
 */
export function audit(entry: AuditEntry): void {
  prisma.auditLog
    .create({
      data: {
        type: entry.type,
        userId: entry.userId ?? null,
        requestId: entry.requestId ?? null,
        method: entry.method,
        url: entry.url ? redactUrl(entry.url) : undefined,
        statusCode: entry.statusCode,
        durationMs: entry.durationMs,
        message: entry.message,
        metadata: entry.metadata === undefined ? undefined : (redact(entry.metadata) as object),
      },
    })
    .catch((err: unknown) => logger.warn({ err }, "Failed to write audit log"));
}

/** Wraps fetch() so every outgoing API call is timed and logged. */
export async function auditedFetch(
  url: string,
  init: RequestInit & { label: string; userId?: string | null; requestId?: string | null },
): Promise<Response> {
  const started = Date.now();
  const { label, userId, requestId, ...fetchInit } = init;
  try {
    const res = await fetch(url, fetchInit);
    audit({
      type: "EXTERNAL_API_CALL",
      userId,
      requestId,
      method: fetchInit.method ?? "GET",
      url,
      statusCode: res.status,
      durationMs: Date.now() - started,
      message: label,
    });
    return res;
  } catch (err) {
    audit({
      type: "ERROR",
      userId,
      requestId,
      method: fetchInit.method ?? "GET",
      url,
      durationMs: Date.now() - started,
      message: `${label} failed: ${(err as Error).message}`,
    });
    throw err;
  }
}
