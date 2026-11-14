import { randomUUID } from "node:crypto";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

/**
 * Sign-in sessions. Each login creates one `sessions` row and a JWT that carries its id
 * (`sid`). Every request checks that session is still active, so:
 *   - signing out revokes only that one session (other devices and other users are untouched)
 *   - changing or resetting the password can end the user's other sessions
 *   - deleting a user deletes their sessions (cascade)
 */

const TOUCH_EVERY_MS = 5 * 60_000;

export async function createSession(user: { id: string; email: string }, req: Request): Promise<string> {
  const sid = randomUUID();
  const token = jwt.sign({ email: user.email, sid }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
  const { exp } = jwt.decode(token) as { exp: number };
  await prisma.session.create({
    data: {
      id: sid,
      userId: user.id,
      userAgent: req.header("user-agent")?.slice(0, 300) ?? null,
      ipAddress: req.ip ?? null,
      expiresAt: new Date(exp * 1000),
    },
  });
  return token;
}

/** The session if it is active and belongs to the user; otherwise null. Refreshes lastUsedAt now and then. */
export async function activeSession(sid: string, userId: string) {
  const session = await prisma.session.findUnique({ where: { id: sid } });
  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date()) return null;
  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    void prisma.session.update({ where: { id: sid }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return session;
}

/** Signs out one session only. */
export async function revokeSession(sid: string, userId: string): Promise<boolean> {
  const { count } = await prisma.session.updateMany({ where: { id: sid, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count > 0;
}

/** Signs out all of one user's sessions, optionally keeping one (the current device). */
export async function revokeUserSessions(userId: string, keepSessionId?: string): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function listSessions(userId: string, currentSessionId?: string) {
  const rows = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, ipAddress: true, lastUsedAt: true, expiresAt: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Removes sessions that ended more than 30 days ago. */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
}
