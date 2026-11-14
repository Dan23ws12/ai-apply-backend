import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { body, validate } from "../middleware/validate.js";
import { LoginBody, RegisterBody } from "../schemas/index.js";
import { ChangePasswordBody, PasswordResetConfirmBody, PasswordResetRequestBody } from "../schemas/account.js";
import { audit } from "../services/audit.service.js";
import { BCRYPT_ROUNDS, changePassword, confirmPasswordReset, requestPasswordReset } from "../services/password.service.js";
import { createSession, listSessions, revokeSession, revokeUserSessions } from "../services/session.service.js";

export const authRouter = Router();

const publicUser = { id: true, firstName: true, lastName: true, email: true, createdAt: true, updatedAt: true } as const;

/** Creates the account and signs it in (one new session). */
authRouter.post("/register", validate({ body: RegisterBody }), async (req, res) => {
  const data = body(req, RegisterBody);
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new HttpError(409, "An account with this email already exists");

  const user = await prisma.user.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      passwordHash: await bcrypt.hash(data.password, BCRYPT_ROUNDS),
      profile: { create: {} },
    },
    select: publicUser,
  });
  audit({ type: "AUTH", userId: user.id, requestId: req.requestId, message: "register" });
  res.status(201).json({ user, token: await createSession(user, req) });
});

/** Signs in: each login is its own session (one per browser or device). */
authRouter.post("/login", validate({ body: LoginBody }), async (req, res) => {
  const { email, password } = body(req, LoginBody);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;

  audit({
    type: "AUTH",
    userId: user?.id,
    requestId: req.requestId,
    message: ok ? "login success" : "login failed",
    metadata: { email },
  });
  if (!user || !ok) throw new HttpError(401, "Email or password is incorrect");

  res.json({
    user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
    token: await createSession(user, req),
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: publicUser });
  res.json({ user });
});

// ── Sign-out ──

/** Signs out this session only. Other devices of the same user, and other users, stay signed in. */
authRouter.post("/logout", requireAuth, async (req, res) => {
  await revokeSession(req.sessionId!, req.user!.id);
  audit({ type: "AUTH", userId: req.user!.id, requestId: req.requestId, message: "logout" });
  res.status(204).end();
});

/** Signs out every session of your account (all your devices). Other users are not affected. */
authRouter.post("/logout-all", requireAuth, async (req, res) => {
  const count = await revokeUserSessions(req.user!.id);
  audit({ type: "AUTH", userId: req.user!.id, requestId: req.requestId, message: `logout from all ${count} session(s)` });
  res.status(204).end();
});

/** Your active sessions; `current` marks this one. */
authRouter.get("/sessions", requireAuth, async (req, res) => {
  res.json({ items: await listSessions(req.user!.id, req.sessionId) });
});

// ── Passwords ──

/**
 * Asks for a reset link. Always answers 202, whether or not the email has an account.
 * Outside production the link is written to the API log (no email sender is set up yet).
 */
authRouter.post("/password-reset/request", validate({ body: PasswordResetRequestBody }), async (req, res) => {
  await requestPasswordReset(body(req, PasswordResetRequestBody).email, req.ip);
  res.status(202).json({ message: "If an account exists for that email, a reset link has been sent." });
});

/** Sets a new password with the token from the reset link. Signs the account out everywhere. */
authRouter.post("/password-reset/confirm", validate({ body: PasswordResetConfirmBody }), async (req, res) => {
  const { token, newPassword } = body(req, PasswordResetConfirmBody);
  await confirmPasswordReset(token, newPassword);
  res.status(204).end();
});

/** Changes your password. Your other sessions are signed out; this one stays signed in. */
authRouter.post("/change-password", requireAuth, validate({ body: ChangePasswordBody }), async (req, res) => {
  const { currentPassword, newPassword } = body(req, ChangePasswordBody);
  await changePassword(req.user!.id, req.sessionId, currentPassword, newPassword);
  res.status(204).end();
});
