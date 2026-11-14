import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.service.js";
import { revokeUserSessions } from "./session.service.js";

/**
 * Password reset and change.
 *
 * Reset tokens are 32 random bytes; only their SHA-256 hash is stored, each works once and
 * expires after PASSWORD_RESET_TTL_MINUTES. Asking for a reset always answers the same way,
 * whether or not the email has an account, so the endpoint can't be used to find accounts.
 *
 * Delivery: no email service is set up yet. Outside production the reset link is written to
 * the API log; deliverResetLink() is the one place to connect a real email sender.
 */

const BCRYPT_ROUNDS = 12;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Simple in-memory throttle: at most 3 reset emails per address and 10 per IP per 15 minutes.
const WINDOW_MS = 15 * 60_000;
const hits = new Map<string, number[]>();
function allowed(key: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

async function deliverResetLink(email: string, link: string) {
  if (env.NODE_ENV !== "production") {
    logger.warn({ email, link }, "Password reset link (development only: connect an email sender for production)");
    return;
  }
  // TODO: send `link` to `email` with your email provider (SMTP, Resend, SES, ...).
  logger.error({ email }, "Password reset requested but no email sender is configured");
}

export async function requestPasswordReset(email: string, ip?: string | null): Promise<void> {
  if (!allowed(`email:${email}`, 3) || !allowed(`ip:${ip ?? "?"}`, 10)) {
    audit({ type: "AUTH", message: "password reset throttled", metadata: { email, ip } });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  audit({ type: "AUTH", userId: user?.id, message: user ? "password reset requested" : "password reset for unknown email", metadata: { email } });
  if (!user) return;

  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    // Only the newest link works.
    prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
        ipAddress: ip ?? null,
      },
    }),
  ]);
  await deliverResetLink(user.email, env.PASSWORD_RESET_URL.replace("{token}", encodeURIComponent(token)));
}

/** Sets a new password from a reset token and signs the user out everywhere. */
export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) {
    throw new HttpError(400, "This reset link is invalid or has expired. Ask for a new one.");
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  // Claim the token in the same transaction, so it can't be used twice at once.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!count) throw new HttpError(400, "This reset link has already been used.");
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
  });
  await revokeUserSessions(row.userId);
  audit({ type: "AUTH", userId: row.userId, message: "password reset completed; all sessions signed out" });
}

/** Changes the password after checking the current one. Other sessions are signed out; this one stays. */
export async function changePassword(userId: string, currentSessionId: string | undefined, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    audit({ type: "AUTH", userId, message: "change password failed: wrong current password" });
    throw new HttpError(400, "Current password is incorrect");
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new HttpError(400, "The new password must be different from the current one");
  }
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } });
  const signedOut = await revokeUserSessions(userId, currentSessionId);
  audit({ type: "AUTH", userId, message: `password changed; ${signedOut} other session(s) signed out` });
}

export { BCRYPT_ROUNDS };
